import { getMessaging, SendResponse } from "firebase-admin/messaging";
import { prisma } from "./prisma";
import { getFirebaseApp } from "./firebase";

// Barcha ro'yxatdan o'tgan admin qurilmalariga FCM push xabarnoma yuboradi.
// Firebase sozlanmagan yoki yuborishda xato bo'lsa ham chaqiruvchini to'xtatmaydi — faqat log qiladi.
export async function sendPushToAdmins(title: string, body: string, data?: Record<string, string>) {
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return;

  try {
    const tokens = await prisma.pushToken.findMany({ select: { token: true } });
    if (tokens.length === 0) return;

    const response = await getMessaging(firebaseApp).sendEachForMulticast({
      tokens: tokens.map(t => t.token),
      notification: { title, body },
      ...(data ? { data } : {}),
    });

    response.responses.forEach((r: SendResponse, i: number) => {
      if (!r.success) {
        console.error(`Push yuborilmadi (token ...${tokens[i].token.slice(-8)}):`, r.error?.message);
      }
    });
  } catch (err) {
    console.error("sendPushToAdmins xato:", err);
  }
}
