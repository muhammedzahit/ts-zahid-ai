package tr.com.osm.liquibase;

/**
 * stdout'a basilan makine-okunur satir onekleri.
 * OSEM botu (lib/liquibaseRun.js) ciktilari bu oneklere gore ayristirir —
 * degistirilirse bot tarafi da guncellenmelidir.
 */
public final class Ciktilar {

    public static final String PROFIL = "PROFIL:";
    public static final String MOD = "MOD:";
    public static final String URL = "URL:";
    public static final String SEMA = "SEMA:";
    public static final String CHANGELOG = "CHANGELOG:";
    public static final String DROP_FIRST = "DROP_FIRST:";
    public static final String BEKLEYEN_ADET = "BEKLEYEN_ADET:";
    public static final String BEKLEYEN = "BEKLEYEN:";
    public static final String SQL_DOSYASI = "SQL_DOSYASI:";
    public static final String UYGULANAN_ADET = "UYGULANAN_ADET:";
    public static final String UYGULANAN = "UYGULANAN:";
    public static final String BASARISIZ_CHANGESET = "BASARISIZ_CHANGESET:";
    public static final String SONUC = "SONUC:";
    public static final String HATA_MESAJI = "HATA_MESAJI:";

    private Ciktilar() {
    }
}
