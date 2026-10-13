package tr.com.osm.liquibase;

import liquibase.Contexts;
import liquibase.LabelExpression;
import liquibase.Liquibase;
import liquibase.changelog.ChangeSet;
import liquibase.exception.LiquibaseException;
import liquibase.integration.spring.SpringLiquibase;

import java.io.IOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Onizleme modu: normal {@link SpringLiquibase} kurulumunu (ayni SpringResourceAccessor,
 * ayni `classpath:` cozumlemesi, ayni sema ayarlari) aynen kullanir ama update yerine
 * bekleyen changeset'leri listeler ve uygulanacak SQL'i bir dosyaya yazar.
 *
 * Veritabanina yazma yapilmaz: liquibase Writer'li update cagrisinda tum ifadeleri
 * calistirmak yerine dosyaya doker. DATABASECHANGELOG tablosu yalnizca okunur.
 */
public class OnizlemeSpringLiquibase extends SpringLiquibase {

    /** Cok uzun listelerde konsolu bogmamak icin stdout'a basilan changeset ust siniri. */
    private static final int LISTE_UST_SINIRI = 200;

    private final Path sqlDosyasi;

    public OnizlemeSpringLiquibase(Path sqlDosyasi) {
        this.sqlDosyasi = sqlDosyasi;
    }

    @Override
    protected void performUpdate(Liquibase liquibase) throws LiquibaseException {
        Contexts contexts = new Contexts();
        LabelExpression labels = new LabelExpression();

        List<ChangeSet> bekleyenler = liquibase.listUnrunChangeSets(contexts, labels);
        System.out.println(Ciktilar.BEKLEYEN_ADET + " " + bekleyenler.size());
        int basilan = Math.min(bekleyenler.size(), LISTE_UST_SINIRI);
        for (int i = 0; i < basilan; i++) {
            ChangeSet cs = bekleyenler.get(i);
            System.out.println(Ciktilar.BEKLEYEN + " " + cs.getFilePath() + " :: " + cs.getId() + " :: " + cs.getAuthor());
        }

        try {
            Path klasor = sqlDosyasi.getParent();
            if (klasor != null) {
                Files.createDirectories(klasor);
            }
            try (Writer writer = Files.newBufferedWriter(sqlDosyasi, StandardCharsets.UTF_8)) {
                liquibase.update(contexts, labels, writer);
            }
        } catch (IOException e) {
            throw new LiquibaseException("Onizleme SQL dosyasi yazilamadi: " + sqlDosyasi, e);
        }

        System.out.println(Ciktilar.SQL_DOSYASI + " " + sqlDosyasi.toAbsolutePath());
    }
}
