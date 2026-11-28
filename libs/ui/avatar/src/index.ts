// Trimmed to the parts the app uses: every class in libs/ui ends up in the
// global stylesheet. Regenerate (`npx nx g @spartan-ng/cli:ui avatar`) to
// get image, fallback, badge and group back.
import { HlmAvatar } from './lib/hlm-avatar';

export * from './lib/hlm-avatar';

export const HlmAvatarImports = [HlmAvatar] as const;
