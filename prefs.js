import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GitLabTasksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Conexión',
            description: 'Conecta con tu instancia de GitLab.',
        });

        const urlRow = new Adw.EntryRow({title: 'URL de GitLab'});
        urlRow.set_text(settings.get_string('gitlab-url'));
        urlRow.connect('notify::text', () => settings.set_string('gitlab-url', urlRow.get_text()));
        group.add(urlRow);

        const tokenRow = new Adw.PasswordEntryRow({title: 'Token de acceso personal'});
        tokenRow.set_text(settings.get_string('private-token'));
        tokenRow.connect('notify::text', () => settings.set_string('private-token', tokenRow.get_text()));
        group.add(tokenRow);

        const intervalRow = new Adw.ActionRow({
            title: 'Intervalo de actualización',
            subtitle: 'En segundos (mínimo 60)',
        });
        const adjustment = new Gtk.Adjustment({
            lower: 60,
            upper: 3600,
            step_increment: 60,
            page_increment: 300,
            value: settings.get_int('poll-interval') || 300,
        });
        const intervalInput = new Gtk.SpinButton({adjustment, numeric: true, valign: Gtk.Align.CENTER});
        intervalInput.set_value(settings.get_int('poll-interval') || 300);
        intervalInput.connect('value-changed', () => {
            settings.set_int('poll-interval', intervalInput.get_value_as_int());
        });
        intervalRow.add_suffix(intervalInput);
        intervalRow.activatable_widget = intervalInput;
        group.add(intervalRow);

        const helpRow = new Adw.ActionRow({
            title: 'Permisos necesarios',
            subtitle: 'read_api permite consultar. Para ejecutar jobs manuales o reintentar fallidos, el token necesita el alcance api, que permite modificar GitLab. Las acciones piden confirmación. El token se guarda localmente en GNOME.',
        });
        group.add(helpRow);

        page.add(group);
        window.add(page);
        window.set_default_size(520, 360);
    }
}
