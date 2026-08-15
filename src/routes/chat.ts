import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/auth";
import { sendPushToAdmins } from "../lib/push";

const router = Router();

const DEFAULT_PAGE_SIZE = 20;

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────

function serializeUserMsg(m: {
  id: string; content: string; createdAt: Date; edited: boolean; editedAt: Date | null;
  readByAdmin: boolean; readAt: Date | null; reply: string | null; replyAt: Date | null; replyEdited: boolean;
}) {
  return {
    id: m.id,
    kind: "user-msg" as const,
    content: m.content,
    createdAt: m.createdAt,
    edited: m.edited,
    editedAt: m.editedAt,
    readByAdmin: m.readByAdmin,
    readAt: m.readAt,
    reply: m.reply,
    replyAt: m.replyAt,
    replyEdited: m.replyEdited,
  };
}

function serializeAdminMsg(m: {
  id: string; content: string; createdAt: Date; readAt: Date | null; edited: boolean; editedAt: Date | null;
}) {
  return {
    id: m.id,
    kind: "admin-direct" as const,
    content: m.content,
    createdAt: m.createdAt,
    readAt: m.readAt,
    edited: m.edited,
    editedAt: m.editedAt,
  };
}

// Bitta suhbat uchun ikkita jadvaldan (Message + AdminMessage) sahifalab
// (cursor-based, Telegram uslubidagi) xabarlarni birlashtirib qaytaradi.
// `before` berilsa — shu vaqtdan OLDINGI xabarlar olinadi (eski xabarlarni yuklash uchun).
async function loadConversationPage(userId: string, before?: Date, limit: number = DEFAULT_PAGE_SIZE) {
  const whereUser = before
    ? { userId, createdAt: { lt: before } }
    : { userId };
  const whereAdmin = before
    ? { toUserId: userId, createdAt: { lt: before } }
    : { toUserId: userId };

  const [userMsgsDesc, adminMsgsDesc] = await Promise.all([
    prisma.message.findMany({ where: whereUser, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.adminMessage.findMany({ where: whereAdmin, orderBy: { createdAt: "desc" }, take: limit }),
  ]);

  type Merged =
    | ({ table: "user" } & typeof userMsgsDesc[number])
    | ({ table: "admin" } & typeof adminMsgsDesc[number]);

  const merged: Merged[] = [
    ...userMsgsDesc.map((m: typeof userMsgsDesc[number]) => ({ table: "user" as const, ...m })),
    ...adminMsgsDesc.map((m: typeof adminMsgsDesc[number]) => ({ table: "admin" as const, ...m })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const page = merged.slice(0, limit);
  const hasMore = merged.length > page.length || userMsgsDesc.length === limit || adminMsgsDesc.length === limit;

  // Eskidan yangiga qarab (render uchun asc tartib)
  const pageAsc = [...page].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const userMsgs = pageAsc.filter((m): m is Merged & { table: "user" } => m.table === "user").map(m => serializeUserMsg(m));
  const adminMsgs = pageAsc.filter((m): m is Merged & { table: "admin" } => m.table === "admin").map(m => serializeAdminMsg(m));

  const oldest = page[page.length - 1];
  const nextCursor = oldest ? oldest.createdAt.toISOString() : null;

  return { userMsgs, adminMsgs, hasMore, nextCursor };
}

// ─────────────────────────────────────────
//  USER ROUTES
// ─────────────────────────────────────────

// GET /chat/messages — user o'z xabarlarini + admin xabarlarini oladi (sahifalab, ?before=&limit=)
router.get("/messages", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId as string;
    const before = req.query.before ? new Date(req.query.before as string) : undefined;
    const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_SIZE, 1), 100) : DEFAULT_PAGE_SIZE;

    const { userMsgs, adminMsgs, hasMore, nextCursor } = await loadConversationPage(userId, before, limit);

    // Faqat birinchi (eng so'nggi) sahifa yuklanganda o'qilmagan javob/xabarlarni belgilaymiz
    if (!before) {
      const unreadUserMsgs = await prisma.message.findMany({
        where: { userId, reply: { not: null }, replyReadAt: null },
        select: { id: true },
      });
      if (unreadUserMsgs.length > 0) {
        const ids = unreadUserMsgs.map((m: { id: string }) => m.id);
        await prisma.message.updateMany({
          where: { id: { in: ids } },
          data: { replyReadAt: new Date() },
        });
      }

      const unreadAdminMsgs = await prisma.adminMessage.findMany({
        where: { toUserId: userId, readAt: null },
        select: { id: true },
      });
      if (unreadAdminMsgs.length > 0) {
        const ids = unreadAdminMsgs.map((m: { id: string }) => m.id);
        await prisma.adminMessage.updateMany({
          where: { id: { in: ids } },
          data: { readAt: new Date() },
        });
        const idSet = new Set(ids);
        adminMsgs.forEach(m => { if (idSet.has(m.id)) m.readAt = new Date(); });
      }
    }

    return res.json({ messages: userMsgs, adminMessages: adminMsgs, hasMore, nextCursor });
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
        readByAdmin: false,
      },
      include: { user: { select: { name: true } } },
    });

    // Push xabarnoma yuborish javobni kutmaydi — sekinlashsa ham userga javob kechikmaydi
    const preview = message.content.length > 100 ? `${message.content.slice(0, 100)}…` : message.content;
    void sendPushToAdmins(message.user.name, preview);

    return res.status(201).json({
      id: message.id,
      kind: "user-msg",
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

    const existing = await prisma.message.findFirst({ where: { id, userId: req.userId as string } });
    if (!existing) return res.status(404).json({ message: "Not found" });

    const updated = await prisma.message.update({
      where: { id },
      data: { content: content.trim(), edited: true, editedAt: new Date() },
    });

    return res.json({ id: updated.id, content: updated.content, edited: true, editedAt: updated.editedAt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /chat/unread-count
router.get("/unread-count", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId as string;

    const [unreadReplies, unreadAdminMsgs] = await Promise.all([
      prisma.message.count({ where: { userId, reply: { not: null }, replyReadAt: null } }),
      prisma.adminMessage.count({ where: { toUserId: userId, readAt: null } }),
    ]);

    return res.json({ count: unreadReplies + unreadAdminMsgs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// ─────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────

// GET /chat/admin/users — foydalanuvchilar ro'yxati + unread hisobi
router.get("/admin/users", authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: "USER" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, email: true, avatar: true, createdAt: true,
        _count: { select: { messages: true } },
      },
    });

    const result = await Promise.all(
      users.map(async (u: typeof users[number]) => {
        const [unreadCount, lastMsg] = await Promise.all([
          // Faqat user → admin xabarlar (admin → user lar user uchun unread)
          prisma.message.count({ where: { userId: u.id, readByAdmin: false } }),
          prisma.message.findFirst({
            where: { userId: u.id },
            orderBy: { createdAt: "desc" },
            select: { content: true, createdAt: true, readByAdmin: true },
          }),
        ]);

        return {
          id: u.id, name: u.name, email: u.email, avatar: u.avatar,
          createdAt: u.createdAt, totalMessages: u._count.messages,
          unreadCount, lastMessage: lastMsg,
        };
      })
    );

    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /chat/admin/conversation/:userId — suhbat tarixi, sahifalab (?before=&limit=)
// Birinchi so'rovda (before yo'q) eng so'nggi `limit` ta xabar qaytadi.
// Yuqoriga scroll qilinganda `before=nextCursor` bilan qayta so'raladi — yana `limit` ta eskiroq xabar keladi.
router.get("/admin/conversation/:userId", authenticate, requireAdmin,
  async (req: Request<{ userId: string }>, res: Response) => {
    try {
      const { userId } = req.params;
      const before = req.query.before ? new Date(req.query.before as string) : undefined;
      const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_SIZE, 1), 100) : DEFAULT_PAGE_SIZE;

      const { userMsgs, adminMsgs, hasMore, nextCursor } = await loadConversationPage(userId, before, limit);

      // Faqat birinchi (eng so'nggi) sahifa ochilganda user xabarlarini "o'qilgan" deb belgilaymiz
      if (!before) {
        await prisma.message.updateMany({
          where: { userId, readByAdmin: false },
          data: { readByAdmin: true, readAt: new Date() },
        });
        userMsgs.forEach(m => { m.readByAdmin = true; });
      }

      return res.json({ messages: userMsgs, adminMessages: adminMsgs, hasMore, nextCursor });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// POST /chat/admin/message/:userId — admin mustaqil xabar yuboradi (adminMessage table)
router.post("/admin/message/:userId", authenticate, requireAdmin,
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
        kind: "admin-direct",
        content: msg.content,
        createdAt: msg.createdAt,
        readAt: null,
        edited: false,
        editedAt: null,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// PATCH /chat/admin/message/:id — admin o'zi yuborgan mustaqil xabarni tahrirlaydi
router.patch("/admin/message/:id", authenticate, requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { id } = req.params;
      const { content } = req.body as { content?: string };
      if (!content?.trim()) return res.status(400).json({ message: "Content required" });

      const existing = await prisma.adminMessage.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "Not found" });

      const updated = await prisma.adminMessage.update({
        where: { id },
        data: { content: content.trim(), edited: true, editedAt: new Date() },
      });

      return res.json({
        id: updated.id,
        kind: "admin-direct",
        content: updated.content,
        edited: true,
        editedAt: updated.editedAt,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// DELETE /chat/admin/message/:id — adminning mustaqil xabarini (AdminMessage) o'chiradi
router.delete("/admin/message/:id", authenticate, requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { id } = req.params;
      const existing = await prisma.adminMessage.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "Not found" });

      await prisma.adminMessage.delete({ where: { id } });
      return res.json({ id, deleted: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// DELETE /chat/admin/user-message/:id — userning xabarini (Message) admin o'chiradi
router.delete("/admin/user-message/:id", authenticate, requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { id } = req.params;
      const existing = await prisma.message.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "Not found" });

      await prisma.message.delete({ where: { id } });
      return res.json({ id, deleted: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// DELETE /chat/admin/users/:id — butun foydalanuvchini (va uning barcha xabarlarini) o'chiradi
router.delete("/admin/users/:id", authenticate, requireAdmin,
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { id } = req.params;
      const existing = await prisma.user.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (existing.role === "ADMIN") return res.status(400).json({ message: "Admin foydalanuvchini o'chirib bo'lmaydi" });

      // Message va AdminMessage yozuvlari onDelete: Cascade orqali avtomatik o'chadi
      await prisma.user.delete({ where: { id } });
      return res.json({ id, deleted: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

router.patch("/admin/reply/:id", authenticate, requireAdmin,
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
        kind: "admin-reply",
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
router.patch("/admin/reply/:id/edit", authenticate, requireAdmin,
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
