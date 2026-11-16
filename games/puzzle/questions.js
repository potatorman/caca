// Original, language-independent puzzle packs shared by the browser UI and Worker.
const ODD_SIGNAL = [
  { id:"odd-01", topic:"Astronomi", prompt:"Hangisi bir gezegen değil, doğal uydudur?", options:["Mars","Venüs","Europa","Jüpiter"], answer:2, explanation:"Europa, Jüpiter'in yörüngesindeki buzlu bir doğal uydudur." },
  { id:"odd-02", topic:"Geometri", prompt:"Hangisi düzlemsel bir çokgen değildir?", options:["Üçgen","Kare","Beşgen","Küre"], answer:3, explanation:"Küre üç boyutlu bir yüzeydir; diğerleri düzlemsel çokgenlerdir." },
  { id:"odd-03", topic:"Doğa", prompt:"Hangisi memeli değildir?", options:["Yunus","Balina","Köpek balığı","Fok"], answer:2, explanation:"Köpek balığı balıktır. Diğer üçü akciğerle nefes alan memelilerdir." },
  { id:"odd-04", topic:"Takvim", prompt:"Hangisi ay adı değil, haftanın günüdür?", options:["Ocak","Mart","Salı","Mayıs"], answer:2, explanation:"Salı haftanın günüdür; diğer seçenekler takvim aylarıdır." },
  { id:"odd-05", topic:"Maddeler", prompt:"Hangisi metal değil, kayaçtır?", options:["Bakır","Demir","Granit","Altın"], answer:2, explanation:"Granit bir kayaçtır; bakır, demir ve altın metallerdir." },
  { id:"odd-06", topic:"Teknoloji", prompt:"Hangisi bir internet iletişim protokolü değildir?", options:["HTTP","FTP","JPEG","SMTP"], answer:2, explanation:"JPEG bir görsel dosya biçimidir. Diğerleri iletişim protokolleridir." },
  { id:"odd-07", topic:"Canlılar", prompt:"Hangisi ağaç ya da bitki değil, mantardır?", options:["Meşe","Çam","Akçaağaç","Şapkalı mantar"], answer:3, explanation:"Şapkalı mantar mantarlar alemindedir; diğerleri ağaçtır." },
  { id:"odd-08", topic:"Ölçüler", prompt:"Hangisi uzunluk birimi değildir?", options:["Kilometre","Metre","Litre","Santimetre"], answer:2, explanation:"Litre hacim ölçer. Diğerleri uzunluk birimleridir." }
];

const PATTERN_PARTY = [
  { id:"pattern-01", topic:"İkiye katla", prompt:"Sıradaki sayı hangisi?  2 · 4 · 8 · 16 · ?", options:["24","28","32","36"], answer:2, explanation:"Her sayı bir öncekinin iki katı. 16 × 2 = 32." },
  { id:"pattern-02", topic:"Fibonacci", prompt:"Diziyi tamamla:  1 · 1 · 2 · 3 · 5 · ?", options:["6","7","8","9"], answer:2, explanation:"Her terim kendinden önceki iki terimin toplamı. 3 + 5 = 8." },
  { id:"pattern-03", topic:"Tek sayılar", prompt:"Eksik sayıyı bul:  3 · 6 · 11 · 18 · 27 · ?", options:["36","38","40","42"], answer:1, explanation:"Artışlar 3, 5, 7, 9 şeklinde ilerler; sıradaki artış 11'dir. 27 + 11 = 38." },
  { id:"pattern-04", topic:"Üçe böl", prompt:"Sıradaki sayı hangisi?  81 · 27 · 9 · 3 · ?", options:["0","1","2","6"], answer:1, explanation:"Her adımda sayı üçe bölünür. 3 ÷ 3 = 1." },
  { id:"pattern-05", topic:"Kareler", prompt:"Diziyi tamamla:  4 · 9 · 16 · 25 · ?", options:["30","32","35","36"], answer:3, explanation:"Bunlar 2², 3², 4², 5². Sıradaki 6² = 36." },
  { id:"pattern-06", topic:"Artan farklar", prompt:"Eksik sayıyı bul:  2 · 3 · 5 · 8 · 12 · ?", options:["15","16","17","18"], answer:2, explanation:"Artışlar 1, 2, 3, 4'tür. Sıradaki artış 5: 12 + 5 = 17." },
  { id:"pattern-07", topic:"Kareler", prompt:"Sıradaki sayı hangisi?  1 · 4 · 9 · 16 · 25 · ?", options:["30","32","36","49"], answer:2, explanation:"Dizi 1², 2², 3², 4², 5² şeklinde; sıradaki 6² = 36." },
  { id:"pattern-08", topic:"Dörde katla", prompt:"Diziyi tamamla:  5 · 10 · 20 · 40 · ?", options:["60","70","75","80"], answer:3, explanation:"Her adımda sayı iki katına çıkar. 40 × 2 = 80." }
];

export const PUZZLE_GAME_IDS = Object.freeze(["odd-signal", "pattern-party"]);
export function getPuzzlePack(gameId) {
  if (gameId === "odd-signal") return ODD_SIGNAL;
  if (gameId === "pattern-party") return PATTERN_PARTY;
  throw new Error("Bilinmeyen bulmaca oyunu.");
}
export function getPublicQuestion(gameId, questionIndex) {
  const question = getPuzzlePack(gameId)[questionIndex];
  if (!question) return null;
  return {
    id: question.id,
    topic: question.topic,
    prompt: question.prompt,
    options: [...question.options]
  };
}
