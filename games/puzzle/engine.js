import { getPuzzlePack } from "./questions.js";

export const QUESTION_TIME_MS = 18_000;
export const REVEAL_TIME_MS = 4_500;
export const MIN_PUZZLE_PLAYERS = 2;
export const MAX_PUZZLE_PLAYERS = 8;

export function shuffle(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

export function scorePuzzleAnswer({ correct, elapsedMs, previousStreak = 0 }) {
  if (!correct) return { points: 0, streak: 0, speedBonus: 0, streakBonus: 0 };
  const boundedElapsed = Math.max(0, Math.min(QUESTION_TIME_MS, Number(elapsedMs) || 0));
  const speedBonus = Math.floor(((QUESTION_TIME_MS - boundedElapsed) / QUESTION_TIME_MS) * 40);
  const streakBonus = Math.min(Math.max(0, Number(previousStreak) || 0), 4) * 10;
  return {
    points: 100 + speedBonus + streakBonus,
    streak: Math.max(0, Number(previousStreak) || 0) + 1,
    speedBonus,
    streakBonus
  };
}

export function createPuzzleMatch({ roomId, lobbyId, round, gameId, playerIds, now = Date.now(), random = Math.random }) {
  const players = [...new Set(Array.isArray(playerIds) ? playerIds.filter((id) => typeof id === "string" && id) : [])];
  const pack = getPuzzlePack(gameId);
  if (players.length < MIN_PUZZLE_PLAYERS || players.length > MAX_PUZZLE_PLAYERS) {
    throw new Error("Bu oyun 2–8 aktif oyuncu gerektirir.");
  }
  if (pack.length < 4) throw new Error("Bulmaca paketi çok kısa.");
  return {
    roomId, lobbyId, round: Number(round), gameId,
    status: "playing",
    phase: "question",
    playerIds: players,
    activePlayerIds: [...players],
    scores: Object.fromEntries(players.map((id) => [id, 0])),
    streaks: Object.fromEntries(players.map((id) => [id, 0])),
    questionOrder: shuffle(pack.map((_, index) => index), random),
    roundIndex: 0,
    phaseStartedAt: now,
    phaseEndsAt: now + QUESTION_TIME_MS,
    answers: {},
    roundAwards: {},
    winnerIds: [],
    returnedIds: [],
    finishedAt: null
  };
}

export function allPlayersAnswered(match) {
  return match.activePlayerIds.length > 0 &&
    match.activePlayerIds.every((uid) => Boolean(match.answers[uid]));
}

export function applyPuzzleAnswer(match, uid, optionIndex, now = Date.now()) {
  if (match.status !== "playing" || match.phase !== "question") throw new Error("Yanıt süresi sona erdi.");
  if (!match.activePlayerIds.includes(uid)) throw new Error("Bu maçın aktif oyuncusu değilsin.");
  if (match.answers[uid]) throw new Error("Bu turda yanıtını zaten gönderdin.");
  const questionIndex = match.questionOrder[match.roundIndex];
  const question = getPuzzlePack(match.gameId)[questionIndex];
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
    throw new Error("Geçerli bir seçenek seçmelisin.");
  }
  const correct = optionIndex === question.answer;
  const scored = scorePuzzleAnswer({
    correct,
    elapsedMs: now - match.phaseStartedAt,
    previousStreak: match.streaks[uid] || 0
  });
  match.answers[uid] = { optionIndex, correct, points: scored.points, answeredAt: now };
  match.scores[uid] = (match.scores[uid] || 0) + scored.points;
  match.streaks[uid] = scored.streak;
  match.roundAwards[uid] = scored.points;
  return { correct, ...scored };
}

export function revealPuzzleRound(match, now = Date.now()) {
  if (match.status !== "playing" || match.phase !== "question") return false;
  const pack = getPuzzlePack(match.gameId);
  const question = pack[match.questionOrder[match.roundIndex]];
  for (const uid of match.activePlayerIds) {
    if (!match.answers[uid]) {
      match.answers[uid] = { optionIndex: null, correct: false, points: 0, answeredAt: null };
      match.streaks[uid] = 0;
      match.roundAwards[uid] = 0;
    }
  }
  match.phase = "reveal";
  match.phaseStartedAt = now;
  match.phaseEndsAt = now + REVEAL_TIME_MS;
  match.revealedAnswer = question.answer;
  match.explanation = question.explanation;
  return true;
}

export function advancePuzzleRound(match, now = Date.now()) {
  const pack = getPuzzlePack(match.gameId);
  if (match.phase !== "reveal") return false;
  if (match.roundIndex + 1 >= pack.length) {
    match.status = "results";
    match.phase = "results";
    match.phaseStartedAt = now;
    match.phaseEndsAt = null;
    match.finishedAt = now;
    const highScore = Math.max(0, ...match.activePlayerIds.map((uid) => match.scores[uid] || 0));
    match.winnerIds = match.activePlayerIds.filter((uid) => (match.scores[uid] || 0) === highScore);
    return true;
  }
  match.roundIndex += 1;
  match.phase = "question";
  match.phaseStartedAt = now;
  match.phaseEndsAt = now + QUESTION_TIME_MS;
  match.answers = {};
  match.roundAwards = {};
  delete match.revealedAnswer;
  delete match.explanation;
  return true;
}
