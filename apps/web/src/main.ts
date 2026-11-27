import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import {
  loadFirebaseOptions,
  provideFirebaseOptions,
} from './app/core/firebase-options';

loadFirebaseOptions()
  .then((firebaseOptions) =>
    bootstrapApplication(App, {
      ...appConfig,
      providers: [
        ...appConfig.providers,
        provideFirebaseOptions(firebaseOptions),
      ],
    }),
  )
  .catch((err) => console.error(err));
