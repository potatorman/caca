# CACA Games

CACA oyunları, RendeChat'in mevcut lobi ve davet sistemine takılabilir küçük modüller olarak tasarlanır.

## Oyun modülleri

- `uno/`: 2–10 oyunculu gerçek zamanlı kart oyunu.
- `vampir-koylu/`: 5–12 oyunculu sosyal çıkarım oyunu.
- `puzzle/`: Ortak motoru kullanan 2–8 oyunculu Odd Signal ve Pattern Party.

## Genişletme sözleşmesi

Her oyun `registry.js` içinde benzersiz bir `id`, oyuncu sınırları ve bir `module` yolu ile kaydedilir. Modül, `open({ db, roomId, round, uid, session, roomMembers, onLeave, onReturnToLobby })` imzasıyla çalışan bir `open` fonksiyonu dışa aktarır.

Lobi oluşturma, davetler, katılma/ayrılma, hazır durumu, geri sayım, izleyiciler ve rematch döngüsü `js/rooms-ui.js` içindeki ortak altyapı tarafından yönetilir; bunları oyun klasörlerinde yeniden uygulamayın. Gerçek zamanlı, rekabete dayalı oyunlarda sunucu hamleleri doğrular ve oyun durumunu Cloudflare Durable Objects üzerinden yayınlar.

Yeni bir sunucu tarafı oyun eklendiğinde Worker route'ları, Durable Object binding/migration ve Node testleri de eklenmelidir. Oyun arayüzleri mevcut sayfa içinde overlay olarak çalışır; dış bağlantı veya iframe kullanmaz.
