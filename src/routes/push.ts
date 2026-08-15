import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireAdmin } from "../middleware/auth";

const router = Router();

// POST /api/admin/push/register — admin (Capacitor) ilovasi FCM token'ini ro'yxatdan o'tkazadi
router.post("/register", authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { token } = req.body as { token?: string };
    if (!token?.trim()) return res.status(400).json({ message: "Token required" });

    await prisma.pushToken.upsert({
      where: { token: token.trim() },
      update: {},
      create: { token: token.trim() },
    });

    return res.status(201).json({ registered: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
