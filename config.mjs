import fs from 'fs';
import ini from 'ini';
import {dirname, join, resolve} from "path";
import * as domain from "node:domain";

export class Config {
    constructor(rootName) {
        this.rootName = rootName || 'metric-im';
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
        this.data = ini.decode("");
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

export class DomainConfig extends Config {
  constructor(rootName,domain) {
    super(rootName);
    this.domain = domain;
    this.domainData = {};
  }

  setDomain(domain) {
    this.domain = domain;
    this.domainConfigDir = join(this.configDir, domain);
    this.domainConfigFile = join(this.domainConfigDir, 'config.ini');
    if (!fs.existsSync(this.domainConfigDir)) {
      fs.mkdirSync(this.domainConfigDir);
      fs.writeFileSync(this.domainConfigFile,JSON.stringify([]));
    }
    this.load();
  }
  load() {
    if (this.domain) {
      const text = fs.readFileSync(this.domainConfigFile);
      this.domainData = ini.decode(text.toString());
    }
    super.load();
  }
  save() {
    if (this.domain) {
      const text = ini.stringify(this.domainData);
      fs.writeFileSync(this.domainConfigFile, text);
    }
    super.save();
  }
  readFile(filename) {
    if (this.domain) return fs.readFileSync(join(this.domainConfigDir, filename));
    else return super.readFile(filename);
  }

  writeFile(filename, data) {
    if (this.domain) fs.writeFileSync(join(this.domainConfigDir, filename), data);
    else return super.writeFile(filename);
  }
}
