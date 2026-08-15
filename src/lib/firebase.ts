import { initializeApp, cert, App } from "firebase-admin/app";

let app: App | undefined;

// Firebase service account sozlanmagan bo'lsa (masalan lokal devda) undefined qaytadi —
// push funksiyalari bunday holatda jim o'tkazib yuboriladi, server yiqilmaydi.
export function getFirebaseApp(): App | undefined {
  if (app) return app;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return undefined;
  }

  app = initializeApp({
    credential: cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  return app;
}
