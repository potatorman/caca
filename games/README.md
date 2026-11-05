# CACA Games

Oda oyunları bu klasörde ayrı modüller halinde tutulur.

## Yapı

- `registry.js`: oyun kataloğu ve oyun modüllerinin kayıtları.
- `uno/`: UNO oyununun kendi mantığı, durum modeli ve arayüzü.
- Her yeni oyun kendi klasöründe tutulur (ör. `tavla/`, `kelime/`).

## Ortak lobi

Oda oluşturma, katılımcıların hazır durumu, izleyici görünümü ve tur sırası ortak oda altyapısıdır. Bunlar oyunların içine kopyalanmaz. Bir oyun modülü seçildiğinde ortak lobi o oyunun başlatma fonksiyonuna bağlanır.

Şu an ortak lobi ve tur sırası altyapısı vardır; UNO oynanış motoru henüz eklenmemiştir.
