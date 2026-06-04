// prisma.config.ts
import { defineConfig } from '@prisma/config';
import * as dotenv from 'dotenv';

dotenv.config(); // .env faylini yuklash uchun

export default defineConfig({
  schema: 'prisma/schema.prisma',
});