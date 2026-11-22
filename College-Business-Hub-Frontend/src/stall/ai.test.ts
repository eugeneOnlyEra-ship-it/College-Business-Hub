import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Firebase SDK: records how each model was configured and returns canned responses.
const made: { params: any; reply: { text: string; source: string } }[] = [];
let nextReply = { text: '', source: 'on_device' };
vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock('firebase/app-check', () => ({ initializeAppCheck: vi.fn(), ReCaptchaEnterpriseProvider: class {} }));
vi.mock('firebase/ai', () => ({
  getAI: vi.fn(() => ({})),
  GoogleAIBackend: class {},
  InferenceMode: { PREFER_ON_DEVICE: 'prefer_on_device', PREFER_IN_CLOUD: 'prefer_in_cloud', ONLY_ON_DEVICE: 'only_on_device', ONLY_IN_CLOUD: 'only_in_cloud' },
  InferenceSource: { ON_DEVICE: 'on_device', IN_CLOUD: 'in_cloud' },
  getGenerativeModel: vi.fn((_ai, params) => {
    const reply = nextReply;
    made.push({ params, reply });
    return { generateContent: vi.fn(async () => ({ response: { text: () => reply.text, inferenceSource: reply.source } })) };
  }),
}));

vi.stubEnv('VITE_FIREBASE_API_KEY', 'k');
vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'p');
vi.stubEnv('VITE_FIREBASE_APP_ID', 'a');
const ai = await import('./ai');

const listings = [
  { id: 'sam', title: 'Samosa', kind: 'PRODUCT' as const, unit: null, active: true, priceCents: 50, costCents: 25, stockQty: 10, lowStockAt: null },
];

beforeEach(() => { made.length = 0; });

describe('hybrid models', () => {
  it('quick questions prefer the device and report where they ran', async () => {
    nextReply = { text: 'You made $2.80 today.', source: 'on_device' };
    const r = await ai.askStall('profit today?', 'Today: profit $2.80');
    expect(r).toEqual({ text: 'You made $2.80 today.', source: 'on_device' });
    expect(made[0].params.mode).toBe('prefer_on_device');
    expect(made[0].params.onDeviceParams.createOptions.expectedInputs[0]).toEqual({ type: 'text', languages: ['en'] });
    expect(made[0].params.inCloudParams.model).toBeTruthy();
  });
  it('weekly advice prefers the cloud', async () => {
    nextReply = { text: '- Restock soda', source: 'in_cloud' };
    expect((await ai.weeklyAdvice('facts')).source).toBe('in_cloud');
    expect(made[0].params.mode).toBe('prefer_in_cloud');
  });
  it('sale parsing sends the same JSON schema to the device and the cloud, and maps the result', async () => {
    nextReply = { text: '{"type":"SALE","item":"Samosa","quantity":3,"unitPriceDollars":0.45}', source: 'on_device' };
    const d = await ai.parseEntry('sold 3 samosas 45c', listings);
    expect(d).toEqual({ type: 'SALE', listingId: 'sam', quantity: 3, unitPriceCents: 45, unitCostCents: undefined, source: 'on_device' });
    const p = made[0].params;
    expect(p.onDeviceParams.promptOptions.responseConstraint.properties.item.enum).toEqual(['Samosa']);
    expect(p.inCloudParams.generationConfig.responseJsonSchema).toBe(p.onDeviceParams.promptOptions.responseConstraint);
  });
  it('refuses an item that is not one of the listings', async () => {
    nextReply = { text: '{"type":"SALE","item":"Pizza","quantity":1}', source: 'on_device' };
    await expect(ai.parseEntry('sold a pizza', listings)).rejects.toThrow();
  });
});
