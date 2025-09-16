/**
 *  Deployment
 *
 *  Open a web hook used by github to
 *
 *
 */
import fs from 'fs';
import ini from 'ini';
import express from 'express';
import {dirname, join, resolve} from "path";

export class Deployment {
  constructor(repositoryPath,branch) {
    this.repositoryPath = repositoryPath;
    this.branch = branch || 'main';
  }

  static attach(app,repositoryPath,branch) {
    const instance = new Deployment(repositoryPath,branch);
    app.use('/',instance.routes());
  }
  routes() {
    const router = new express.Router();
    router.get('/_update',(req, res) => {
      // spawn command line script to:
      // - stop the service
      // - pull this.branch from this.repositoryPath from Github
      // - npm i
      // - restart service
    })
  }
}
