import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";

const router = Router();

// ─────────────────────────────────────────
//  USER ROUTES
// ─────────────────────────────────────────

// GET /chat/messages — user o'z xabarlarini + admin xabarlarini oladi
router.get("/messages", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId as string;

    // User xabarlari
    const userMsgs = await prisma.message.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    // Admin tomonidan bu userga yuborilgan mustaqil xabarlar
    const adminMsgs = await prisma.adminMessage.findMany({
      where: { toUserId: userId },
      orderBy: { createdAt: "asc" },
    });

    // Admin javob bergan bo'lsa va user hali ko'rmagan bo'lsa — replyReadAt set
    const unreadReplyIds = userMsgs
      .filter(m => m.reply && !m.replyReadAt)
      .map(m => m.id);

    if (unreadReplyIds.length > 0) {
      await prisma.message.updateMany({
        where: { id: { in: unreadReplyIds } },
        data: { replyReadAt: new Date() },
      });
    }

    // Admin mustaqil xabarlarini user ko'rdi deb belgilash
    const unreadAdminMsgIds = adminMsgs
      .filter(m => !m.readAt)
      .map(m => m.id);

    if (unreadAdminMsgIds.length > 0) {
      await prisma.adminMessage.updateMany({
        where: { id: { in: unreadAdminMsgIds } },
        data: { readAt: new Date() },
      });
    }

    return res.json({
      messages: userMsgs.map(m => ({
        id: m.id,
        type: "user" as const,
        content: m.content,
        createdAt: m.createdAt,
        edited: m.edited,
        editedAt: m.editedAt,
        readByAdmin: m.readByAdmin,
        readAt: m.readAt,
        reply: m.reply,
        replyAt: m.replyAt,
        replyEdited: m.replyEdited,
      })),
      adminMessages: adminMsgs.map(m => ({
        id: m.id,
        type: "admin" as const,
        content: m.content,
        createdAt: m.createdAt,
        readAt: m.readAt,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /chat/messages — user xabar yuboradi
router.post("/messages", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content?.trim()) return res.status(400).json({ message: "Content required" });

    const message = await prisma.message.create({
      data: {
        content: content.trim(),
        userId: req.userId as string,
        readByAdmin: false, // yangi xabar — o'qilmagan
      },
    });

    return res.status(201).json({
      id: message.id,
      type: "user",
      content: message.content,
      createdAt: message.createdAt,
      edited: false,
      readByAdmin: false,
      reply: null,
      replyAt: null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /chat/messages/:id — user xabarni tahrirlaydi
router.patch("/messages/:id", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { content } = req.body as { content?: string };
    if (!content?.trim()) return res.status(400).json({ message: "Content required" });

    const existing = await prisma.message.findFirst({
      where: { id, userId: req.userId as string },
    });
    if (!existing) return res.status(404).json({ message: "Not found" });

    const updated = await prisma.message.update({
      where: { id },
      data: { content: content.trim(), edited: true, editedAt: new Date() },
    });

    return res.json({
      id: updated.id,
      content: updated.content,
      edited: true,
      editedAt: updated.editedAt,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /chat/unread-count — user uchun o'qilmagan admin javoblar soni
router.get("/unread-count", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId as string;

    // O'qilmagan reply lar
    const unreadReplies = await prisma.message.count({
      where: { userId, reply: { not: null }, replyReadAt: null },
    });

    // O'qilmagan admin mustaqil xabarlar
    const unreadAdminMsgs = await prisma.adminMessage.count({
      where: { toUserId: userId, readAt: null },
    });

    return res.json({ count: unreadReplies + unreadAdminMsgs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────

// GET /chat/admin/users — foydalanuvchilar ro'yxati
router.get(
  "/admin/users",
  authenticate,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const users = await prisma.user.findMany({
        where: { role: "USER" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          createdAt: true,
          _count: { select: { messages: true } },
        },
      });

      // Har user uchun unread + last message ni alohida query
      const result = await Promise.all(
        users.map(async u => {
          const [unreadCount, lastMsg] = await Promise.all([
            prisma.message.count({
              where: { userId: u.id, readByAdmin: false },
            }),
            prisma.message.findFirst({
              where: { userId: u.id },
              orderBy: { createdAt: "desc" },
              select: { content: true, createdAt: true, readByAdmin: true },
            }),
          ]);

          return {
            id: u.id,
            name: u.name,
            email: u.email,
            avatar: u.avatar,
            createdAt: u.createdAt,
            totalMessages: u._count.messages,
            unreadCount,
            lastMessage: lastMsg,
          };
        })
      );

      return res.json(result);
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// GET /chat/admin/conversation/:userId — suhbat tarixi
router.get(
  "/admin/conversation/:userId",
  authenticate,
  requireAdmin,
  async (req: Request<{ userId: string }>, res: Response) => {
    try {
      const { userId } = req.params;

      const [userMsgs, adminMsgs] = await Promise.all([
        prisma.message.findMany({
          where: { userId },
          orderBy: { createdAt: "asc" },
        }),
        prisma.adminMessage.findMany({
          where: { toUserId: userId },
          orderBy: { createdAt: "asc" },
        }),
      ]);

      // O'qilmagan user xabarlarini o'qilgan deb belgilash
      await prisma.message.updateMany({
        where: { userId, readByAdmin: false },
        data: { readByAdmin: true, readAt: new Date() },
      });

      return res.json({
        messages: userMsgs.map(m => ({
          id: m.id,
          type: "user" as const,
          content: m.content,
          createdAt: m.createdAt,
          edited: m.edited,
          editedAt: m.editedAt,
          readByAdmin: true,
          readAt: m.readAt,
          reply: m.reply,
          replyAt: m.replyAt,
          replyEdited: m.replyEdited,
        })),
        adminMessages: adminMsgs.map(m => ({
          id: m.id,
          type: "admin" as const,
          content: m.content,
          createdAt: m.createdAt,
          readAt: m.readAt,
        })),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// POST /chat/admin/message/:userId — admin mustaqil xabar yuboradi
router.post(
  "/admin/message/:userId",
  authenticate,
  requireAdmin,
  async (req: Request<{ userId: string }>, res: Response) => {
    try {
      const { userId } = req.params;
      const { content } = req.body as { content?: string };
      if (!content?.trim()) return res.status(400).json({ message: "Content required" });

      const msg = await prisma.adminMessage.create({
        data: { content: content.trim(), toUserId: userId },
      });

      return res.status(201).json({
        id: msg.id,
        type: "admin",
        content: msg.content,
        createdAt: msg.createdAt,
        readAt: null,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// PATCH /chat/admin/reply/:id — user xabariga javob
router.patch(
  "/admin/reply/:id",
  authenticate,
  requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const id = req.params.id;
      const { reply } = req.body as { reply?: string };
      if (!reply?.trim()) return res.status(400).json({ message: "Reply required" });

      const message = await prisma.message.update({
        where: { id },
        data: { reply: reply.trim(), replyAt: new Date(), replyReadAt: null },
      });

      return res.json({
        id: message.id,
        reply: message.reply,
        replyAt: message.replyAt,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// PATCH /chat/admin/reply/:id/edit — admin javobni tahrirlaydi
router.patch(
  "/admin/reply/:id/edit",
  authenticate,
  requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const id = req.params.id;
      const { reply } = req.body as { reply?: string };
      if (!reply?.trim()) return res.status(400).json({ message: "Reply required" });

      const message = await prisma.message.update({
        where: { id },
        data: { reply: reply.trim(), replyEdited: true, replyReadAt: null },
      });

      return res.json({ id: message.id, reply: message.reply, replyEdited: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;