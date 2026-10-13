package tr.com.osm.liquibase;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * `osem.liquibase.*` ayarlari. Mod komut satirindan gecilir:
 *   --osem.liquibase.mode=update
 */
@ConfigurationProperties(prefix = "osem.liquibase")
public class RunnerProperties {

    public enum Mode {
        /** Bekleyen changeset'leri listeler ve SQL uretir; veritabanina yazmaz. */
        PREVIEW,
        /** Bekleyen changeset'leri veritabanina uygular. */
        UPDATE
    }

    /** Guvenli varsayilan: acikca istenmedikce veritabanina yazilmaz. */
    private Mode mode = Mode.PREVIEW;

    private String changeLog = "classpath:db/changelog/changelog-master.xml";

    private String defaultSchema = "portal";

    /** Onizleme modunda uretilen SQL dosyalarinin yazilacagi klasor. */
    private String outputDir = "target/preview";

    public Mode getMode() {
        return mode;
    }

    public void setMode(Mode mode) {
        this.mode = mode;
    }

    public String getChangeLog() {
        return changeLog;
    }

    public void setChangeLog(String changeLog) {
        this.changeLog = changeLog;
    }

    public String getDefaultSchema() {
        return defaultSchema;
    }

    public void setDefaultSchema(String defaultSchema) {
        this.defaultSchema = defaultSchema;
    }

    public String getOutputDir() {
        return outputDir;
    }

    public void setOutputDir(String outputDir) {
        this.outputDir = outputDir;
    }
}
