import { Global, Module } from '@nestjs/common';
import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { AppConfigService } from '../config/app-config.service';
import {
  FirebaseIdentityProvider,
  IdentityProvider,
} from './identity.provider';
import { FIREBASE_APP, FIREBASE_AUTH, FIRESTORE } from './firebase.tokens';

/**
 * Firebase Admin SDK. Credentials come from Application Default Credentials;
 * the SDK talks to the emulators when FIREBASE_AUTH_EMULATOR_HOST /
 * FIRESTORE_EMULATOR_HOST are set.
 */
@Global()
@Module({
  providers: [
    {
      provide: FIREBASE_APP,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): App =>
        initializeApp({ projectId: config.firebase.projectId }),
    },
    {
      provide: FIREBASE_AUTH,
      inject: [FIREBASE_APP],
      useFactory: (app: App) => getAuth(app),
    },
    {
      provide: FIRESTORE,
      inject: [FIREBASE_APP],
      useFactory: (app: App) => getFirestore(app),
    },
    { provide: IdentityProvider, useClass: FirebaseIdentityProvider },
  ],
  exports: [FIRESTORE, IdentityProvider],
})
export class FirebaseModule {}
