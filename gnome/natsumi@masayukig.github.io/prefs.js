import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NatsumiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const server = new Adw.EntryRow({title: 'サーバー（https://…）', show_apply_button: true,
            text: settings.get_string('server-url')});
        server.connect('apply', () => settings.set_string('server-url', server.text.trim()));
        group.add(server);

        const scale = new Adw.SpinRow({title: '大きさ（%）',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 200, step_increment: 25})});
        settings.bind('scale', scale, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(scale);

        for (const [key, title] of [['face-icons', '顔のアイコンで出す（spritesheet の代わりに）'],
            ['flee', 'マウスが近くにいると逃げる']]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        window.add(page);
    }
}
