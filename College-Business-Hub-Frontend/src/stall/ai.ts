import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  type GenerativeModel,
  type OnDeviceParams,
} from 'firebase/ai';
import type { StallListing } from './types';

/**
 * Stall mode's AI, through Firebase AI Logic hybrid inference.
 *
 * - Quick questions and sale parsing PREFER ON-DEVICE (Gemini Nano in Chrome): free, private, and they work offline.
 *   When the device has no local model, the same call goes to Gemini in the cloud.
 * - Weekly advice PREFERS THE CLOUD (a bigger model, better advice) and falls back to the device when offline.
 * - The model never does the arithmetic. It gets a sheet of numbers worked out in code (numbers.ts) and puts them into words.
 *
 * On-device inference is single-turn and ignores `systemInstruction`, so every prompt carries its own instructions.
 */

const env = import.meta.env;
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
};
const CLOUD_MODEL = (env.VITE_GEMINI_CLOUD_MODEL as string | undefined) || 'gemini-3.5-flash-lite';

/** Firebase is set up for this build (otherwise Stall mode still works, with calculated answers only). */
export const aiConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

let app: FirebaseApp | null = null;
function ai() {
  if (!aiConfigured) throw new Error('Firebase is not configured for this build.');
  if (!app) {
    app = initializeApp(firebaseConfig);
    // Firebase AI Logic requires App Check. During development a debug token is printed in the console:
    // add it in the Firebase console under App Check > Manage debug tokens. Never ship a debug token to the public.
    const debug = env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;
    if (env.DEV || debug) (globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = debug || true;
    const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined;
    if (siteKey || env.DEV || debug) {
      initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey ?? 'debug-only'), isTokenAutoRefreshEnabled: true });
    }
  }
  return getAI(app, { backend: new GoogleAIBackend() });
}

const english = { type: 'text' as const, languages: ['en'] };
const onDevice = (promptOptions?: OnDeviceParams['promptOptions']): OnDeviceParams => ({
  createOptions: { expectedInputs: [english], expectedOutputs: [english] },
  ...(promptOptions ? { promptOptions } : {}),
});

function model(mode: (typeof InferenceMode)[keyof typeof InferenceMode], opts: { maxOutputTokens: number; schema?: object }): GenerativeModel {
  return getGenerativeModel(ai(), {
    mode,
    onDeviceParams: onDevice(opts.schema ? { responseConstraint: opts.schema } : undefined),
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: opts.maxOutputTokens,
        ...(opts.schema ? { responseMimeType: 'application/json', responseJsonSchema: opts.schema as Record<string, unknown> } : {}),
      },
    },
  });
}

export type Source = 'on_device' | 'in_cloud';
export interface AiText { text: string; source: Source }

async function run(m: GenerativeModel, prompt: string): Promise<AiText> {
  const r = await m.generateContent(prompt);
  const text = r.response.text().trim();
  if (!text) throw new Error('The model returned nothing.');
  return { text, source: r.response.inferenceSource === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud' };
}

// ---- What the device can do right now ----

export type DeviceState = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api';

interface PromptApi {
  availability(o?: unknown): Promise<string>;
}

/** Whether Chrome's built-in Gemini Nano is ready. Never starts a download. */
export async function deviceState(): Promise<DeviceState> {
  const LM = (globalThis as unknown as { LanguageModel?: PromptApi }).LanguageModel;
  if (!LM) return 'no-api';
  try {
    const a = await LM.availability({ expectedInputs: [english], expectedOutputs: [english] });
    return (['available', 'downloadable', 'downloading', 'unavailable'].includes(a) ? a : 'unavailable') as DeviceState;
  } catch {
    return 'unavailable';
  }
}

/** Downloads Gemini Nano so answers work offline. Chrome only allows this right after a click or key press. */
export async function prepareDeviceModel(onProgress: (fraction: number) => void) {
  await model(InferenceMode.PREFER_ON_DEVICE, { maxOutputTokens: 50 }).initializeDeviceModel(onProgress);
}

// ---- The three jobs ----

const RULES = `Rules: use ONLY the facts below. Copy every dollar amount exactly as it is written in the facts.
Never add, subtract, multiply or estimate money yourself. If the facts do not answer the question, say what is missing.
Plain, friendly English for a student running a small stall. No markdown headings.`;

/** A quick question about profit, sales or stock. Prefers the device. */
export function askStall(question: string, facts: string): Promise<AiText> {
  const prompt = `You help a student who runs a small business answer questions about their own sales and stock.
${RULES}
Answer in at most 3 short sentences.

FACTS:
${facts}

QUESTION: ${question.slice(0, 400)}`;
  return run(model(InferenceMode.PREFER_ON_DEVICE, { maxOutputTokens: 220 }), prompt);
}

/** A short plan for the coming week. Prefers the bigger cloud model, falls back to the device when offline. */
export function weeklyAdvice(facts: string): Promise<AiText> {
  const prompt = `You coach a student who runs a small campus business. Using the facts, give exactly 3 practical suggestions for next week:
what to restock and roughly how many units (based on the daily pace shown), which item earns the most and how to sell more of it,
and one thing to fix (an item with no cost recorded, a low-margin item, or slow stock).
${RULES}
Write 3 bullet points starting with "- ", one or two sentences each.

FACTS:
${facts}`;
  return run(model(InferenceMode.PREFER_IN_CLOUD, { maxOutputTokens: 400 }), prompt);
}

export interface SaleDraft {
  type: 'SALE' | 'RESTOCK';
  listingId: string;
  quantity: number;
  /** Per unit, in cents. Only when the owner said a price. */
  unitPriceCents?: number;
  unitCostCents?: number;
}

/** Turns "sold 3 samosas" or "got 24 sodas at 55c" into a draft the owner confirms. Prefers the device. */
export async function parseEntry(text: string, listings: StallListing[]): Promise<SaleDraft & { source: Source }> {
  const titles = listings.map((l) => l.title);
  const schema = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['SALE', 'RESTOCK'] },
      item: { type: 'string', enum: titles },
      quantity: { type: 'integer', minimum: 1, maximum: 10000 },
      unitPriceDollars: { type: 'number', description: 'Price per unit the buyer paid, only if the owner said it.' },
      unitCostDollars: { type: 'number', description: 'Cost per unit for a restock, only if the owner said it.' },
    },
    required: ['type', 'item', 'quantity'],
  };
  const prompt = `A student who runs a stall typed a note about something that just happened. Turn it into JSON.
"SALE" means they sold to a customer. "RESTOCK" means they bought or received more units.
Pick "item" from this list only: ${titles.map((t) => JSON.stringify(t)).join(', ')}.
Only include unitPriceDollars or unitCostDollars if the note states an amount. A note like "50c" means 0.50 dollars.

NOTE: ${text.slice(0, 300)}`;
  const r = await run(model(InferenceMode.PREFER_ON_DEVICE, { maxOutputTokens: 120, schema }), prompt);
  const raw = JSON.parse(r.text) as { type?: string; item?: string; quantity?: number; unitPriceDollars?: number; unitCostDollars?: number };
  const listing = listings.find((l) => l.title === raw.item);
  const quantity = Number.isInteger(raw.quantity) && raw.quantity! > 0 ? raw.quantity! : NaN;
  if (!listing || !Number.isFinite(quantity) || (raw.type !== 'SALE' && raw.type !== 'RESTOCK')) {
    throw new Error('The model could not read that note.');
  }
  const cents = (d?: number) => (typeof d === 'number' && d >= 0 && d < 1000 ? Math.round(d * 100) : undefined);
  return { type: raw.type, listingId: listing.id, quantity, unitPriceCents: cents(raw.unitPriceDollars), unitCostCents: cents(raw.unitCostDollars), source: r.source };
}
