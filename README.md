# MAXIMA IELTS Tracker

Aktif geliştirme klasörü. Uygulama kaynakları 3 Kasım 2026 tarihinde yayımlanan sürümle eşitlenmiştir.

Canlı uygulama: https://ielts-tracker-lemon.vercel.app

Yerel durum, doğrulama sonuçları ve kalan işler `PROJECT_STATUS.json` dosyasındadır.
Eski denemeler ve eşitleme öncesi çalışmalar orada belirtilen yedek klasöründe korunur.

## Yerel geliştirme

Node.js 22 kullanın. `npm run build` üretim derlemesini oluşturur.
`npm run dev` geliştirme sunucusunu açar. Aktif Firebase ayarı gerçek projeye bağlıdır;
veri yazan testleri yalnız ayrı, emülatöre bağlı UAT klasöründe çalıştırın.

## Yayın ve test durumu

Bu eşitleme yerel bir düzenlemedir; yeni dağıtım veya uzak Git gönderimi yapmaz.
Uygulama kodu yayımlanan sürümle aynıdır. Bazı eski testler önceki kelime sınırı
beklentilerini içerir; ayrıntıları `PROJECT_STATUS.json` içinde kayıtlıdır.
