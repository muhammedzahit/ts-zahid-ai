package tr.com.osm.liquibase;

import liquibase.integration.spring.SpringLiquibase;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * SpringLiquibase bean'i burada elle kurulur (application.yml'de
 * `spring.liquibase.enabled: false`), cunku onizleme modunda davranisi
 * degistiren bir alt sinif kullaniyoruz.
 */
@Configuration
@EnableConfigurationProperties(RunnerProperties.class)
public class LiquibaseConfig {

    private static final DateTimeFormatter DOSYA_ZAMANI = DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss");

    /**
     * dropFirst KESINLIKLE false. Sabit olarak tutulur, ayardan okunmaz:
     * true olsaydi liquibase butun semayi silip changelog'u sifirdan kurardi.
     * Bu arac hicbir profilde bunu yapmamalidir.
     */
    private static final boolean DROP_FIRST = false;

    @Bean
    public SpringLiquibase springLiquibase(DataSource dataSource,
                                           RunnerProperties props,
                                           Environment env,
                                           @Value("${spring.datasource.url}") String jdbcUrl) {

        String profil = String.join(",", env.getActiveProfiles());
        boolean onizleme = props.getMode() == RunnerProperties.Mode.PREVIEW;

        System.out.println(Ciktilar.PROFIL + " " + (profil.isEmpty() ? "(yok)" : profil));
        System.out.println(Ciktilar.MOD + " " + props.getMode());
        System.out.println(Ciktilar.URL + " " + jdbcUrl);
        System.out.println(Ciktilar.SEMA + " " + props.getDefaultSchema());
        System.out.println(Ciktilar.CHANGELOG + " " + props.getChangeLog());
        System.out.println(Ciktilar.DROP_FIRST + " " + DROP_FIRST);

        SpringLiquibase liquibase = onizleme
                ? new OnizlemeSpringLiquibase(onizlemeDosyasi(props, profil))
                : new UygulamaSpringLiquibase();

        liquibase.setDataSource(dataSource);
        liquibase.setChangeLog(props.getChangeLog());
        liquibase.setDefaultSchema(props.getDefaultSchema());
        liquibase.setLiquibaseSchema(props.getDefaultSchema());
        liquibase.setDropFirst(DROP_FIRST);
        liquibase.setShouldRun(true);
        return liquibase;
    }

    private Path onizlemeDosyasi(RunnerProperties props, String profil) {
        String ad = "onizleme-" + (profil.isEmpty() ? "profilsiz" : profil)
                + "-" + LocalDateTime.now().format(DOSYA_ZAMANI) + ".sql";
        return Paths.get(props.getOutputDir(), ad);
    }
}
