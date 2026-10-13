package tr.com.osm.liquibase;

import liquibase.changelog.ChangeSet;
import liquibase.changelog.DatabaseChangeLog;
import liquibase.changelog.visitor.AbstractChangeExecListener;
import liquibase.database.Database;

import java.util.ArrayList;
import java.util.List;

/**
 * Update sirasinda liquibase'in gercekten uyguladigi changeset'leri toplar.
 *
 * Log satirlarini ("ChangeSet ... ran successfully") ayristirmak yerine bu
 * dinleyici kullanilir; cunku o loglar onizleme modunda da basilir ve calisma
 * tipini (EXECUTED / MARK_RAN / SKIPPED / RERAN) ayirt etmez.
 */
public class UygulananDinleyici extends AbstractChangeExecListener {

    private final List<String> uygulananlar = new ArrayList<>();
    private String basarisizChangeSet;

    @Override
    public void ran(ChangeSet changeSet, DatabaseChangeLog changeLog, Database database, ChangeSet.ExecType execType) {
        uygulananlar.add(kimlik(changeSet) + " :: " + execType);
    }

    @Override
    public void runFailed(ChangeSet changeSet, DatabaseChangeLog changeLog, Database database, Exception e) {
        basarisizChangeSet = kimlik(changeSet);
    }

    private static String kimlik(ChangeSet changeSet) {
        return changeSet.getFilePath() + " :: " + changeSet.getId() + " :: " + changeSet.getAuthor();
    }

    /**
     * Toplanani stdout'a basar. Hata durumunda da cagrilir: liquibase her
     * changeset'i ayri commit ettigi icin, patlamadan once uygulananlarin
     * bilinmesi onemli.
     */
    public void ozetiBas() {
        System.out.println(Ciktilar.UYGULANAN_ADET + " " + uygulananlar.size());
        for (String u : uygulananlar) {
            System.out.println(Ciktilar.UYGULANAN + " " + u);
        }
        if (basarisizChangeSet != null) {
            System.out.println(Ciktilar.BASARISIZ_CHANGESET + " " + basarisizChangeSet);
        }
    }
}
