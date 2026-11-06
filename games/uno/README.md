# UNO

UNO, CACA'nın oda başına kalıcı oyun lobisine bağlanan 2–10 oyunculu kart oyunudur.

- `deck.js`: 108 kartlık deste ve karıştırma.
- `engine.js`: Merkezi oynanabilirlik ve sıra kuralları.
- `state.js`: Firestore maç oluşturma, atomik hamleler, özel eller ve canlı abonelik.
- `ui.js`: Responsive masa ve kart arayüzü.
- `index.js`: Oyun modülü giriş noktası.

Maçlar `rooms/{roomId}/unoMatches/{round}` altında tutulur. Her oyuncunun eli kendi `hands/{uid}` belgesindedir; ortak `gameSessions/active` belgesine UNO kartları veya deste yazılmaz.

Güvenlik notu: Firestore Rules diğer oyuncuların ellerini ve çekme destesinin sırası gelmemiş kartlarını okumayı engeller; hamleleri atomik işlem ve sıra kontrolüyle sınırlar. Çekme kartları yalnızca aktif oyuncuya açılır ( +4 / UNO cezası için gerektiğinde en fazla dört kart okunabilir). Ancak kart dağıtımı istemci tarafından başlatılır ve kuralların tüm semantik doğrulaması tarayıcı motoruna dayanır. Tarayıcı kodunu değiştirebilen kötü niyetli oyuncuya karşı bu sürüm sunucu otoriteli / hileye dayanıklı değildir. Bunun için güvenilir sunucu bileşeni gerekir; Cloud Functions dağıtımı Blaze faturalandırması istediğinden mevcut sürümde özellikle eklenmemiştir.
