// Writes apps/web/public/__/firebase/init.json for local development against
// the Auth emulator (`npm run emulators`). It uses the project id from
// .firebaserc (the emulators run under it) with a fake api key and app id;
// every auth request goes to the emulator, never to the real project.
// The emulator switch is honored in dev builds only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const projectId = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects
  .default;
const dir = 'apps/web/public/__/firebase';
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}/init.json`,
  JSON.stringify(
    {
      projectId,
      apiKey: 'emulator-fake-api-key',
      authDomain: `${projectId}.firebaseapp.com`,
      appId: 'emulator-app',
      authEmulatorUrl: 'http://127.0.0.1:9099',
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Wrote ${dir}/init.json for the Auth emulator (project ${projectId}).`,
);
