import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scoresTable = pgTable("scores", {
  id: serial("id").primaryKey(),
  aliveCount: integer("alive_count").notNull(),
  deadCount: integer("dead_count").notNull(),
  zombieCount: integer("zombie_count").notNull(),
  proteinUsed: integer("protein_used").notNull(),
  balancedCount: integer("balanced_count").notNull(),
  choiceScore: integer("choice_score").notNull(),
  totalScore: integer("total_score").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertScoreSchema = createInsertSchema(scoresTable).omit({ id: true, createdAt: true });
export type InsertScore = z.infer<typeof insertScoreSchema>;
export type Score = typeof scoresTable.$inferSelect;
