// The C1–C8 provider contracts (DESIGN-045 D-04…D-11) — typed interfaces + zod schemas.
// This barrel is the ONLY surface a provider imports from; the core imports from here too.
export * from './media-kind';
export * from './capabilities';
export * from './health';
export * from './subscription-entry';
export * from './scheduling';
export * from './assets';
export * from './context';
export * from './provider';
