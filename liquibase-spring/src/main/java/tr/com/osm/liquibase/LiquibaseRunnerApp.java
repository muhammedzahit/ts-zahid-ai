package tr.com.osm.liquibase;

import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Liquibase changelog'larini calistiran kucuk, web'siz Spring Boot uygulamasi.
 *
 * Calistirma:
 *   java -cp "target/classes;target/lib/*" tr.com.osm.liquibase.LiquibaseRunnerApp \
 *        --spring.profiles.active=staging --osem.liquibase.mode=update
 *
 * Profiller (baglanilacak veritabanini belirler): staging | prod
 * Modlar: preview (sadece SQL uretir, DB'ye yazmaz) | update (gercekten uygular)
 *
 * Cikti, bot tarafindan ayrilabilsin diye "ANAHTAR: deger" satirlari halinde
 * stdout'a basilir (bkz. {@link Ciktilar}). Cikis kodu: 0 basarili, 1 hata.
 */
@SpringBootApplication
public class LiquibaseRunnerApp {

    public static void main(String[] args) {
        int cikisKodu = 0;
        try {
            SpringApplication app = new SpringApplication(LiquibaseRunnerApp.class);
            app.setWebApplicationType(WebApplicationType.NONE);
            app.setBannerMode(Banner.Mode.OFF);
            // Liquibase, SpringLiquibase bean'i olusturulurken (afterPropertiesSet)
            // calisir; run() hatasiz donduyse islem tamamlanmis demektir.
            try (ConfigurableApplicationContext ctx = app.run(args)) {
                // Baglanti havuzu kapansin diye context hemen kapatilir.
            }
            System.out.println(Ciktilar.SONUC + " BASARILI");
        } catch (Throwable t) {
            System.out.println(Ciktilar.SONUC + " HATA");
            System.out.println(Ciktilar.HATA_MESAJI + " " + kokMesaj(t));
            t.printStackTrace(System.out);
            cikisKodu = 1;
        }
        System.out.flush();
        System.exit(cikisKodu);
    }

    /** Spring'in sardigi istisnalarda asil sebep daha aciklayici olur. */
    private static String kokMesaj(Throwable t) {
        Throwable kok = t;
        while (kok.getCause() != null && kok.getCause() != kok) {
            kok = kok.getCause();
        }
        String mesaj = kok.getMessage();
        return kok.getClass().getSimpleName() + ": " + (mesaj == null ? "(mesaj yok)" : mesaj.replace('\n', ' '));
    }
}
