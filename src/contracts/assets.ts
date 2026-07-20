import { z } from 'zod';

/**
 * C8 (DESIGN-045 D-11) — OPTIONAL. Peloton generates thumbnails and owns poster durability;
 * YouTube has none. For v1 the app-side Peloton poster guard is UNTOUCHED — declaring the seam
 * means it exists when the fold-in fork (Q-04) is taken; exercising it is out of v1 scope.
 */
export const assetDescriptorSchema = z.object({
  entryKey: z.string().min(1),
  kind: z.enum(['thumbnail', 'poster']),
  ref: z.string().min(1),
});
export type AssetDescriptor = z.infer<typeof assetDescriptorSchema>;
