# MAXIMA IELTS Tracker

Aktif geliştirme klasörü. Uygulama kaynakları 3 Kasım 2026 tarihinde yayımlanan sürümle eşitlenmiştir.

Canlı uygulama: https://ielts-tracker-lemon.vercel.app

Yerel durum, doğrulama sonuçları ve kalan işler `PROJECT_STATUS.json` dosyasındadır.
Eski denemeler ve eşitleme öncesi çalışmalar orada belirtilen yedek klasöründe korunur.

## Yerel geliştirme

Vercel Node.js 24 kullanır; yerel geliştirmede de Node.js 24 kullanın. `npm run build` üretim derlemesini oluşturur.
`npm run dev` geliştirme sunucusunu açar. Aktif Firebase ayarı gerçek projeye bağlıdır;
veri yazan testleri yalnız ayrı, emülatöre bağlı UAT klasöründe çalıştırın.

## Yayın ve test durumu

Güncel kaynaklar GitHub `main` dalında tutulur. Vercel bu dalı üretim yayını için izler.
Uygulama kodu yayımlanan sürümle aynıdır. Bazı eski testler önceki kelime sınırı
beklentilerini içerir; ayrıntıları `PROJECT_STATUS.json` içinde kayıtlıdır.

## Manuel değişiklik ve yayın

1. Değişiklik öncesi `git pull --ff-only` ile güncel `main` dalını alın.
2. Dosyaları düzenleyin; `npm run build` ile derlemeyi kontrol edin.
3. Değişiklikleri gözden geçirip Git kaydı oluşturun ve `main` dalına gönderin.
4. Vercel’de bu kayda ait dağıtımın READY olduğunu ve canlı bağlantının çalıştığını doğrulayın.

Kaydetmek veya yerel Git kaydı oluşturmak yayın yapmaz. `main` dalına gönderim
Vercel’in ön yüz yayınını başlatır. Başarısız derleme yeni sürüm olarak devreye girmez.
Daha büyük değişikliklerde ayrı bir dal kullanıp önce Vercel ön izlemesinde kontrol edin.

`functions/`, `firestore.rules` ve `storage.rules` değişiklikleri Git gönderimiyle
Firebase’e yayınlanmaz. Bunları ayrı test edip ilgili Firebase bileşenini ayrıca yayınlayın.
Gizli anahtarları ve `.env` dosyalarını Git’e eklemeyin.
