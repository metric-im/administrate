/**
 *  Synchronize
 *
 *  Open a web hook, or monitor a branch, so that the app running this
 *  code will automatically remain in sync with the given branch of the
 *  given repository on Github.
 *
 */
import fs from 'fs';
import express from 'express';
import {resolve} from "path";
import {spawn} from 'child_process';

export class Synchronize {
  constructor(branch) {
    this.repositoryPath = this.discoverRepositoryPath();
    this.branch = branch || 'main';
    this.appName = this.getAppName();
  }

  static attach(app,branch) {
    const instance = new Synchronize(branch);
    app.use('/',instance.routes());
  }

  discoverRepositoryPath() {
    try {
      const packageJsonPath = resolve(process.cwd(), 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.repository) {
          return process.cwd();
        }
      }
    } catch (error) {
      console.warn('Could not find repository path:', error.message);
    }
    return process.cwd(); // fallback to current directory
  }

  getAppName() {
    try {
      const packageJsonPath = resolve(this.repositoryPath || process.cwd(), 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return packageJson.name;
      }
    } catch (error) {
      console.warn('Could not extract app name from package.json:', error.message);
    }

    // Fallback: extract from repository path or current directory
    const repoPath = this.repositoryPath || process.cwd();
    return repoPath.split('/').pop();
  }

  routes() {
    const router = new express.Router();
    router.get(/^\/_update/, async (req, res) => {
      try {
        await this.update();
        res.json({success: true, message: 'Update completed successfully'});
      } catch (error) {
        res.status(500).json({success: false, error: error.message});
      }
    });
    return router;
  }
  async update() {
    console.log(`Starting deployment update for ${this.repositoryPath} on branch ${this.branch}`);

    try {
      // Pull latest changes from GitHub
      await this.executeCommand('git', ['fetch', 'origin', this.branch]);
      await this.executeCommand('git', ['reset', '--hard', `origin/${this.branch}`]);

      // Install/update dependencies
      await this.executeCommand('npm', ['install']);

      // Restart the service using systemctl
      console.log(`Restarting service: ${this.appName}`);
      await this.executeCommand('sudo', ['systemctl', 'restart', this.appName]);

      console.log('Deployment update completed successfully');
    } catch (error) {
      console.error('Deployment update failed:', error.message);
      throw error;
    }
  }

  executeCommand(command, args) {
    return new Promise((resolve, reject) => {
      console.log(`Executing: ${command} ${args.join(' ')}`);
      const process = spawn(command, args, {
        stdio: 'inherit',
        cwd: this.repositoryPath || process.cwd()
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command "${command} ${args.join(' ')}" failed with exit code ${code}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }
}
