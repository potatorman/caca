# UNO

CACA oda lobisine bağlı 2–10 oyunculu UNO.

- `deck.js`: 108 kartlık deste ve karıştırma.
- `engine.js`: Kart eşleştirme, +4 kontrolü ve özel kart sırası.
- `state.js`: Firestore maç durumu ve hamleler.
- `ui.js`: UNO masası ve kart arayüzü.
- `index.js`: CACA oyun kaydı.

Maç ve çekme destesi `unoMatches/{round}` belgesinde tutulur. Her oyuncunun eli ayrı `hands/{uid}` belgesindedir. Oda lobisinin mevcut `gameSessions/active` yapısı değiştirilmez.
