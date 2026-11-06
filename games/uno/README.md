# UNO

CACA oda lobisine bağlı 2–10 oyunculu UNO.

- `deck.js`: 108 kartlık deste.
- `engine.js`: Kart eşleştirme ve özel kart kuralları.
- `state.js`: Firestore maç durumu ve atomik hamleler.
- `ui.js`: Masaüstü ve mobil oyun ekranı.
- `index.js`: CACA oyun kaydı.

Maç durumu `rooms/{roomId}/unoMatches/{round}` altında; her oyuncunun eli ayrı `hands/{uid}` belgesindedir. `gameSessions/active` yalnızca CACA'nın mevcut kalıcı lobi alanlarını kullanır.
