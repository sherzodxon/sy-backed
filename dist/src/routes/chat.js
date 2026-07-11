"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const DEFAULT_PAGE_SIZE = 20;
// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function serializeUserMsg(m) {
    return {
        id: m.id,
        kind: "user-msg",
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
function serializeAdminMsg(m) {
    return {
        id: m.id,
        kind: "admin-direct",
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
async function loadConversationPage(userId, before, limit = DEFAULT_PAGE_SIZE) {
    const whereUser = before
        ? { userId, createdAt: { lt: before } }
        : { userId };
    const whereAdmin = before
        ? { toUserId: userId, createdAt: { lt: before } }
        : { toUserId: userId };
    const [userMsgsDesc, adminMsgsDesc] = await Promise.all([
        prisma_1.prisma.message.findMany({ where: whereUser, orderBy: { createdAt: "desc" }, take: limit }),
        prisma_1.prisma.adminMessage.findMany({ where: whereAdmin, orderBy: { createdAt: "desc" }, take: limit }),
    ]);
    const merged = [
        ...userMsgsDesc.map((m) => ({ table: "user", ...m })),
        ...adminMsgsDesc.map((m) => ({ table: "admin", ...m })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const page = merged.slice(0, limit);
    const hasMore = merged.length > page.length || userMsgsDesc.length === limit || adminMsgsDesc.length === limit;
    // Eskidan yangiga qarab (render uchun asc tartib)
    const pageAsc = [...page].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const userMsgs = pageAsc.filter((m) => m.table === "user").map(m => serializeUserMsg(m));
    const adminMsgs = pageAsc.filter((m) => m.table === "admin").map(m => serializeAdminMsg(m));
    const oldest = page[page.length - 1];
    const nextCursor = oldest ? oldest.createdAt.toISOString() : null;
    return { userMsgs, adminMsgs, hasMore, nextCursor };
}
// ─────────────────────────────────────────
//  USER ROUTES
// ─────────────────────────────────────────
// GET /chat/messages — user o'z xabarlarini + admin xabarlarini oladi (sahifalab, ?before=&limit=)
router.get("/messages", auth_1.authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const before = req.query.before ? new Date(req.query.before) : undefined;
        const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), 100) : DEFAULT_PAGE_SIZE;
        const { userMsgs, adminMsgs, hasMore, nextCursor } = await loadConversationPage(userId, before, limit);
        // Faqat birinchi (eng so'nggi) sahifa yuklanganda o'qilmagan javob/xabarlarni belgilaymiz
        if (!before) {
            const unreadUserMsgs = await prisma_1.prisma.message.findMany({
                where: { userId, reply: { not: null }, replyReadAt: null },
                select: { id: true },
            });
            if (unreadUserMsgs.length > 0) {
                const ids = unreadUserMsgs.map((m) => m.id);
                await prisma_1.prisma.message.updateMany({
                    where: { id: { in: ids } },
                    data: { replyReadAt: new Date() },
                });
            }
            const unreadAdminMsgs = await prisma_1.prisma.adminMessage.findMany({
                where: { toUserId: userId, readAt: null },
                select: { id: true },
            });
            if (unreadAdminMsgs.length > 0) {
                const ids = unreadAdminMsgs.map((m) => m.id);
                await prisma_1.prisma.adminMessage.updateMany({
                    where: { id: { in: ids } },
                    data: { readAt: new Date() },
                });
                const idSet = new Set(ids);
                adminMsgs.forEach(m => { if (idSet.has(m.id))
                    m.readAt = new Date(); });
            }
        }
        return res.json({ messages: userMsgs, adminMessages: adminMsgs, hasMore, nextCursor });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// POST /chat/messages — user xabar yuboradi
router.post("/messages", auth_1.authenticate, async (req, res) => {
    try {
        const { content } = req.body;
        if (!content?.trim())
            return res.status(400).json({ message: "Content required" });
        const message = await prisma_1.prisma.message.create({
            data: {
                content: content.trim(),
                userId: req.userId,
                readByAdmin: false,
            },
        });
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
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// PATCH /chat/messages/:id — user xabarni tahrirlaydi
router.patch("/messages/:id", auth_1.authenticate, async (req, res) => {
    try {
        const id = req.params.id;
        const { content } = req.body;
        if (!content?.trim())
            return res.status(400).json({ message: "Content required" });
        const existing = await prisma_1.prisma.message.findFirst({ where: { id, userId: req.userId } });
        if (!existing)
            return res.status(404).json({ message: "Not found" });
        const updated = await prisma_1.prisma.message.update({
            where: { id },
            data: { content: content.trim(), edited: true, editedAt: new Date() },
        });
        return res.json({ id: updated.id, content: updated.content, edited: true, editedAt: updated.editedAt });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// GET /chat/unread-count
router.get("/unread-count", auth_1.authenticate, async (req, res) => {
    try {
        const userId = req.userId;
        const [unreadReplies, unreadAdminMsgs] = await Promise.all([
            prisma_1.prisma.message.count({ where: { userId, reply: { not: null }, replyReadAt: null } }),
            prisma_1.prisma.adminMessage.count({ where: { toUserId: userId, readAt: null } }),
        ]);
        return res.json({ count: unreadReplies + unreadAdminMsgs });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// ─────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────
// GET /chat/admin/users — foydalanuvchilar ro'yxati + unread hisobi
router.get("/admin/users", auth_1.authenticate, auth_1.requireAdmin, async (_req, res) => {
    try {
        const users = await prisma_1.prisma.user.findMany({
            where: { role: "USER" },
            orderBy: { createdAt: "desc" },
            select: {
                id: true, name: true, email: true, avatar: true, createdAt: true,
                _count: { select: { messages: true } },
            },
        });
        const result = await Promise.all(users.map(async (u) => {
            const [unreadCount, lastMsg] = await Promise.all([
                // Faqat user → admin xabarlar (admin → user lar user uchun unread)
                prisma_1.prisma.message.count({ where: { userId: u.id, readByAdmin: false } }),
                prisma_1.prisma.message.findFirst({
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
        }));
        return res.json(result);
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// GET /chat/admin/conversation/:userId — suhbat tarixi, sahifalab (?before=&limit=)
// Birinchi so'rovda (before yo'q) eng so'nggi `limit` ta xabar qaytadi.
// Yuqoriga scroll qilinganda `before=nextCursor` bilan qayta so'raladi — yana `limit` ta eskiroq xabar keladi.
router.get("/admin/conversation/:userId", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const before = req.query.before ? new Date(req.query.before) : undefined;
        const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), 100) : DEFAULT_PAGE_SIZE;
        const { userMsgs, adminMsgs, hasMore, nextCursor } = await loadConversationPage(userId, before, limit);
        // Faqat birinchi (eng so'nggi) sahifa ochilganda user xabarlarini "o'qilgan" deb belgilaymiz
        if (!before) {
            await prisma_1.prisma.message.updateMany({
                where: { userId, readByAdmin: false },
                data: { readByAdmin: true, readAt: new Date() },
            });
            userMsgs.forEach(m => { m.readByAdmin = true; });
        }
        return res.json({ messages: userMsgs, adminMessages: adminMsgs, hasMore, nextCursor });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// POST /chat/admin/message/:userId — admin mustaqil xabar yuboradi (adminMessage table)
router.post("/admin/message/:userId", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { content } = req.body;
        if (!content?.trim())
            return res.status(400).json({ message: "Content required" });
        const msg = await prisma_1.prisma.adminMessage.create({
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
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// PATCH /chat/admin/message/:id — admin o'zi yuborgan mustaqil xabarni tahrirlaydi
router.patch("/admin/message/:id", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;
        if (!content?.trim())
            return res.status(400).json({ message: "Content required" });
        const existing = await prisma_1.prisma.adminMessage.findUnique({ where: { id } });
        if (!existing)
            return res.status(404).json({ message: "Not found" });
        const updated = await prisma_1.prisma.adminMessage.update({
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
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// DELETE /chat/admin/message/:id — adminning mustaqil xabarini (AdminMessage) o'chiradi
router.delete("/admin/message/:id", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await prisma_1.prisma.adminMessage.findUnique({ where: { id } });
        if (!existing)
            return res.status(404).json({ message: "Not found" });
        await prisma_1.prisma.adminMessage.delete({ where: { id } });
        return res.json({ id, deleted: true });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// DELETE /chat/admin/user-message/:id — userning xabarini (Message) admin o'chiradi
router.delete("/admin/user-message/:id", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await prisma_1.prisma.message.findUnique({ where: { id } });
        if (!existing)
            return res.status(404).json({ message: "Not found" });
        await prisma_1.prisma.message.delete({ where: { id } });
        return res.json({ id, deleted: true });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// DELETE /chat/admin/users/:id — butun foydalanuvchini (va uning barcha xabarlarini) o'chiradi
router.delete("/admin/users/:id", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const existing = await prisma_1.prisma.user.findUnique({ where: { id } });
        if (!existing)
            return res.status(404).json({ message: "Not found" });
        if (existing.role === "ADMIN")
            return res.status(400).json({ message: "Admin foydalanuvchini o'chirib bo'lmaydi" });
        // Message va AdminMessage yozuvlari onDelete: Cascade orqali avtomatik o'chadi
        await prisma_1.prisma.user.delete({ where: { id } });
        return res.json({ id, deleted: true });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
router.patch("/admin/reply/:id", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const { reply } = req.body;
        if (!reply?.trim())
            return res.status(400).json({ message: "Reply required" });
        const message = await prisma_1.prisma.message.update({
            where: { id },
            data: { reply: reply.trim(), replyAt: new Date(), replyReadAt: null },
        });
        return res.json({
            id: message.id,
            kind: "admin-reply",
            reply: message.reply,
            replyAt: message.replyAt,
        });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
// PATCH /chat/admin/reply/:id/edit — admin javobni tahrirlaydi
router.patch("/admin/reply/:id/edit", auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const { reply } = req.body;
        if (!reply?.trim())
            return res.status(400).json({ message: "Reply required" });
        const message = await prisma_1.prisma.message.update({
            where: { id },
            data: { reply: reply.trim(), replyEdited: true, replyReadAt: null },
        });
        return res.json({ id: message.id, reply: message.reply, replyEdited: true });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ message: "Server error" });
    }
});
exports.default = router;
