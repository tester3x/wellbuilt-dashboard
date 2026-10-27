// Entry point for the isolated weekly-forms deployment package. Keep the normal
// dashboard index for discovery; this runtime only loads this callable's graph.
import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
  admin.firestore().settings({ ignoreUndefinedProperties: true });
}

export { jsaWeeklyForms } from './jsaWeeklyFormsCallable';
