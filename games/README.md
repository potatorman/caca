# CACA Games

Oda oyunları bağımsız oyun modülleri halinde tutulur ve `registry.js` üzerinden ortak oyun lobisine kaydedilir.

## Modül yapısı

- `registry.js`: oyun kataloğu, minimum/maksimum oyuncu ve modül giriş noktaları.
- `uno/`: UNO kuralları, durum istemcisi ve masa arayüzü.
- `starfall/`: Starfall Grid skor motoru, WebSocket istemcisi ve responsive masa arayüzü.
- `vampir-koylu/`: sosyal çıkarım motoru, roller, botlar ve arayüz.

Her oyun `index.js` içinde `id`, oyuncu sınırları ve `open()` arayüzünü dışa aktarır. Yeni bir oyun eklemek için oyun klasörü oluştur, kayıt dosyasına ekle ve Worker tarafında gerekiyorsa kendi Durable Object sınıfını bağla.

## Ortak oda ve gerçek zamanlı altyapı

Firebase; oda üyeliğini, davetleri, oyun lobilerini, hazır durumunu ve kalıcı oyuncu listesini yönetir. Cloudflare Worker kısa ömürlü Firebase-kimlikli biletler verir. Durable Objects her maçın otoriter durumunu, WebSocket yayınlarını, yeniden bağlanmayı ve sıra zaman aşımını yönetir.

Oyun modülleri davet/lobi/üyelik akışını kopyalamaz; ortak RendeChat akışına bağlanır. Yeni Worker tabanlı oyunlar için Worker rotaları, Durable Object binding/migration ve ilgili istemci yaşam döngüsü eylemleri eklenmelidir.
