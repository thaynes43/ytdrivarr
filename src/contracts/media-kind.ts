import { z } from 'zod';

/**
 * DESIGN-045 D-12 (as amended at Acceptance — the Q-03 override, owner 2026-07-20): music is
 * FIRST-CLASS from M2. Every Source and Library carries a mediaKind set at subscribe time; the
 * renderer supports BOTH preset families structurally from M1 (proved with fixtures here; the
 * real YouTube provider that implements both is M2).
 */
export const mediaKindSchema = z.enum(['video', 'music']);
export type MediaKind = z.infer<typeof mediaKindSchema>;
