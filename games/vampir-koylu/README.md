# Vampir Köylü

CACA's Vampir Köylü game is designed for 5–12 players.

## Roles

- **Vampir:** secretly chooses a living non-vampire to attack each night.
- **Doktor:** secretly chooses one living player to protect each night; the doctor may protect themself.
- **Köylü:** has no night action and helps identify the vampires during discussion and voting.

There is no detective role.

## Role distribution

| Players | Vampirs | Doktor | Köylüler |
|---:|---:|---:|---:|
| 5–7 | 1 | 1 | Remaining players |
| 8–12 | 2 | 1 | Remaining players |

## Round

1. **Gece — 25 seconds:** Vampirs select a target; the Doktor selects a player to protect. With two Vampirs, both must choose the same target for an attack to succeed.
2. **Gündüz — 45 seconds:** Living players discuss in the in-game Köy Meydanı chat. Eliminated players can read but cannot send messages.
3. **Oylama — 20 seconds:** Living players vote for another living player. A unique highest vote eliminates that player; a tie eliminates nobody.

A phase advances early when all required actions have been submitted. Otherwise the server advances it when the timer expires.

## Victory

- **Köylüler win** when no Vampirs remain alive.
- **Vampirs win** when the number of living Vampirs is equal to or greater than the number of other living players.

Roles are private during play. An eliminated player's role is revealed, and all roles are revealed at the end.


## Lobi ayarları ve botlar

Lobi sahibi, oyun başlamadan önce **Lobi Ayarları** bölümünden botlarla oynamayı açıp kapatabilir.

- **Botlarla oyna kapalı:** En az 5 gerçek oyuncu gerekir.
- **Botlarla oyna açık:** En az 1 gerçek oyuncu yeterlidir.
- **Hedef toplam oyuncu:** 5–12 arasında seçilir.
- **Bot sayısı:** Seçilen hedef sayıdan gerçek oyuncu sayısı çıkarılarak hesaplanır.

Örnek: 2 gerçek oyuncu ve 5 kişilik hedef = 3 bot.

Botlar Firebase kullanıcıları veya oda üyeleri değildir. Maç başlatıldığında Cloudflare Durable Object içinde oluşturulurlar; kalıcı oda üye listesine, hazır listesine veya sonuç dönüş onaylarına eklenmezler. Her yeni turda mevcut lobi ayarlarına göre yeniden oluşturulurlar.

### Bot davranışları

- **Vampir botu:** Gece yaşayan vampir olmayan bir hedef seçer. Diğer vampir botların seçimini takip eder. Bir vampir oyuncu gerçek kullanıcıysa bot, kullanıcının gizli hedef seçimini bekleyip aynı hedefe yönelir; zaman aşımında kendi seçimini yapar.
- **Doktor botu:** Yaşayan bir oyuncuyu korur; bazen kendisini de seçebilir.
- **Köylü botu:** Gündüz konuşmalarındaki herkese açık şüphe ifadelerini ve açıklanmış rolleri değerlendirerek oy verir. Gizli rol tablosuna erişmez.
- **Tüm botlar:** Türkçe tartışma mesajları gönderebilir ve normal gece, gündüz, oylama, elenme ve kazanma kurallarına tabidir.

Botlar harici bir yapay zekâ API'si kullanmaz. Kararları ve konuşmaları Worker içinde çalışan kurallı davranış fonksiyonlarıyla üretilir.
