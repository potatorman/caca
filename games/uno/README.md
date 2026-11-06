# UNO

UNO, CACA'nın oda başına kalıcı oyun lobisine bağlanan 2–10 oyunculu kart oyunudur.

- `deck.js`: 108 kartlık deste ve karıştırma.
- `engine.js`: Merkezi oynanabilirlik ve sıra kuralları.
- `state.js`: Firestore maç oluşturma, atomik hamleler, özel eller ve canlı abonelik.
- `ui.js`: Responsive masa ve kart arayüzü.
- `index.js`: Oyun modülü giriş noktası.

Maçlar `rooms/{roomId}/unoMatches/{round}` altında tutulur. Her oyuncunun eli kendi `hands/{uid}` belgesindedir; ortak `gameSessions/active` belgesine UNO kartları veya deste yazılmaz.

Güvenlik notu: Firestore Rules diğer oyuncuların ellerini okumayı engeller ve maç otoritesini sıra oyuncusuyla sınırlar. Ancak kart dağıtımı ve kurala uygunluk tamamen istemci kodunda yürütüldüğünden, tarayıcı kodunu değiştirebilen kötü niyetli bir oyuncuya karşı sunucu otoriteli / hileye dayanıklı değildir. Bunu sağlamak için Cloud Functions veya başka bir güvenilir sunucu bileşeni gerekir; mevcut sürüm ücretli altyapı gerektirmeyen istemci tabanlı sürümdür.
