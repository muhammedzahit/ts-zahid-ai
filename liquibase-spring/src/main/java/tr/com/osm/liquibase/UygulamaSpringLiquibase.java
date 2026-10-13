package tr.com.osm.liquibase;

import liquibase.Liquibase;
import liquibase.exception.LiquibaseException;
import liquibase.integration.spring.SpringLiquibase;

/**
 * Normal update davranisinin aynisi; tek farki uygulanan changeset'leri
 * {@link UygulananDinleyici} ile toplayip ciktiya basmasi.
 *
 * Update'in kendisi {@code super.performUpdate} ile yapilir — tag/context/label
 * islemesi SpringLiquibase'in kendi mantiginda kalsin diye.
 */
public class UygulamaSpringLiquibase extends SpringLiquibase {

    @Override
    protected void performUpdate(Liquibase liquibase) throws LiquibaseException {
        UygulananDinleyici dinleyici = new UygulananDinleyici();
        liquibase.setChangeExecListener(dinleyici);
        try {
            super.performUpdate(liquibase);
        } finally {
            // Hata firlasa bile o ana kadar uygulananlar raporlanmali.
            dinleyici.ozetiBas();
        }
    }
}
