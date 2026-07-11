"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const google_auth_library_1 = require("google-auth-library");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const googleClient = new google_auth_library_1.OAuth2Client(process.env.GOOGLE_CLIENT_ID);
function signToken(id, role) {
    return jsonwebtoken_1.default.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: "30d" });
}
function safeUser(user) {
    return { id: user.id, name: user.name, email: user.email, avatar: user.avatar, role: user.role };
}
// POST /api/auth/register
router.post("/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password)
            return res.status(400).json({ message: "All fields required" });
        const exists = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (exists)
            return res.status(409).json({ message: "Email already in use" });
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const user = await prisma_1.prisma.user.create({
            data: { name, email, password: hashed },
        });
        const token = signToken(user.id, user.role);
        return res.status(201).json({ token, user: safeUser(user) });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Server error" });
    }
});
// POST /api/auth/admin-login
router.post("/admin-login", (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
        return res.status(500).json({ message: "Admin password not configured" });
    }
    if (password !== adminPassword) {
        return res.status(401).json({ message: "Invalid admin password" });
    }
    // Sign a special admin token (no userId, just role)
    const token = jsonwebtoken_1.default.sign({ id: "admin", role: "ADMIN" }, process.env.JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token });
});
// POST /api/auth/login
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (!user || !user.password)
            return res.status(401).json({ message: "Invalid credentials" });
        const valid = await bcryptjs_1.default.compare(password, user.password);
        if (!valid)
            return res.status(401).json({ message: "Invalid credentials" });
        const token = signToken(user.id, user.role);
        return res.json({ token, user: safeUser(user) });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Server error" });
    }
});
// POST /api/auth/google
router.post("/google", async (req, res) => {
    console.log(process.env.GOOGLE_CLIENT_ID);
    try {
        const { token } = req.body;
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload?.email)
            return res.status(400).json({ message: "Invalid Google token" });
        let user = await prisma_1.prisma.user.findFirst({
            where: { OR: [{ googleId: payload.sub }, { email: payload.email }] },
        });
        if (!user) {
            user = await prisma_1.prisma.user.create({
                data: {
                    name: payload.name || payload.email,
                    email: payload.email,
                    googleId: payload.sub,
                    avatar: payload.picture,
                },
            });
        }
        else if (!user.googleId) {
            user = await prisma_1.prisma.user.update({
                where: { id: user.id },
                data: { googleId: payload.sub, avatar: payload.picture },
            });
        }
        const jwtToken = signToken(user.id, user.role);
        return res.json({ token: jwtToken, user: safeUser(user) });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Google auth failed" });
    }
});
// GET /api/auth/me
router.get("/me", auth_1.authenticate, async (req, res) => {
    try {
        const user = await prisma_1.prisma.user.findUnique({ where: { id: req.userId } });
        if (!user)
            return res.status(404).json({ message: "User not found" });
        return res.json(safeUser(user));
    }
    catch {
        return res.status(500).json({ message: "Server error" });
    }
});
exports.default = router;
