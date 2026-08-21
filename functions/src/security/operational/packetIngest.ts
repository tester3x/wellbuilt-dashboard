/**
 * Legacy ingestDriverPacket is retired. Public packets/incoming is not a
 * supported API. Callers must use submitFieldCommand with Firebase Auth.
 */
import * as httpsV2 from 'firebase-functions/v2/https';

export const ingestDriverPacket = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async () => {
    throw new httpsV2.HttpsError(
      'failed-precondition',
      'ingestDriverPacket_retired_use_submitFieldCommand',
    );
  },
);

export { submitFieldCommand } from './fieldCommands';
