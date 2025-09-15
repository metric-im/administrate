import fs from 'fs';
import ini from 'ini';
import {dirname, join, resolve} from "path";

export default class Config {
    constructor() {
        this.rootName = process.env.ROOT_NAME || 'metric-im';
        this.homeDir = (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME);
        this.configDir = join(this.homeDir, '.' + this.rootName);
        this.configFile = join(this.configDir, 'config.ini');
        if (!fs.existsSync(this.configFile)) {
            this.initialize();
        } else {
            this.load();
        }
    }

    initialize() {
        let fileData = fs.readFileSync(`${this.rootPath}/default.ini`, 'utf8');
        this.data = ini.decode({});
        if (!fs.existsSync(this.configDir)) {
            fs.mkdirSync(this.configDir);
        }
        this.save()
    }

    load() {
        let fileData = fs.readFileSync(this.configFile);
        this.data = ini.decode(fileData.toString());
    }

    save() {
        let text = ini.stringify(this.data, {});
        fs.writeFileSync(this.configFile, text);
    }

    readFile(filename) {
        return fs.readFileSync(join(this.configDir, filename));
    }

    writeFile(filename, data) {
        fs.writeFileSync(join(this.configDir, filename), data);
    }
}
