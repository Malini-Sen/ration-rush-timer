import { Router, type IRouter } from "express";
import { db, scoresTable } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

const SubmitScoreBody = z.object({
  aliveCount:    z.number().int().min(0).max(5),
  deadCount:     z.number().int().min(0).max(5),
  zombieCount:   z.number().int().min(0).max(5),
  proteinUsed:   z.number().int().min(0),
  balancedCount: z.number().int().min(0).max(5),
  choiceScore:   z.number().int(),
});

router.post("/score", async (req, res) => {
  const parsed = SubmitScoreBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid data" });
    return;
  }

  const { aliveCount, deadCount, zombieCount, proteinUsed, balancedCount, choiceScore } = parsed.data;

  const totalScore =
    aliveCount    * 10 +
    proteinUsed   * 2  +
    balancedCount * 2  +
    deadCount     * -10 +
    zombieCount   * -5  +
    choiceScore;

  await db.insert(scoresTable).values({
    aliveCount, deadCount, zombieCount,
    proteinUsed, balancedCount, choiceScore,
    totalScore,
  });

  res.json({ totalScore });
});

export default router;
