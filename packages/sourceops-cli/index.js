'use strict';

const fs = require('fs');
const path = require('path');
const globby = require('globby');
const jsYaml = require('js-yaml');
const execa = require('execa');

const gitUrlParse = require('git-url-parse');
const parser = require('@babel/parser');
const argv = require('minimist')(process.argv.slice(2), { string: '_' });

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  });

async function main() {
  const targetDir = argv.target;

  const gitRepos = await globby(['**/.git'], {
    absolute: true,
    onlyDirectories: true,
    cwd: targetDir
  });

  const acc = {};

  for (const repoGitPath of gitRepos) {
    await fetchPackages(acc, path.dirname(repoGitPath));
  }

  fs.writeFileSync('data.yaml', jsYaml.safeDump(acc, { lineWidth: 160 }));
}

async function fetchPackages(acc, repoPath) {
  try {
    const packages = await globby(['**/package.json'], {
      absolute: true,
      cwd: repoPath
    });

    const files = await findAllSources(repoPath);
    const imports = await extractImportsWithGrep(files, repoPath);

    for (const pkgPath of packages) {
      const pkg = require(pkgPath);

      extractDependencies(acc, pkg.dependencies, repoPath, imports);
      extractDependencies(acc, pkg.devDependencies, repoPath, imports);
      extractDependencies(acc, pkg.peerDependencies, repoPath, imports);
      extractDependencies(acc, pkg.optionalDependencies, repoPath, imports);
    }
  } catch (err) {
    console.error(repoPath, err);
  }
}

function extractDependencies(acc, obj = {}, repoPath, imports) {
  Object.entries(obj).forEach(([name, version]) => {
    acc[name] = acc[name] || {
      description: '',
      tags: [],
      projects: [],
    };

    acc[name].projects.push({
      repo: repoPath,
      version,
      imports: imports.filter(_ => _.dep === name)
    });
  });
}

async function extractImportsWithGrep(files, repoPath) {
  const gitRemote = await execa.stdout('git', ['config', '--get', 'remote.origin.url'], {
    cwd: repoPath
  });

  const branch = await execa.stdout('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath
  });

  const { resource, owner, name } = gitUrlParse(gitRemote);

  const result = [];

  for (const file of files) {
    const fileUrl = `https://${resource}/${owner}/${name}/blob/${branch}/${file.replace(repoPath + '/', '')}`
    const content = fs.readFileSync(file, 'utf-8');
    const regexps = [
      /import ([\w\s\d{}]+) from '([\w\.\\\/\-\_\@]+)'/g,
      /import '([\w\.\\\/\-\_\@]+)'/g,
      /require\(['|"|`]([\w\.\\\/\-\_\@]+)['|"|`]\)/g,
    ];

    for (const regexp of regexps) {
      let match;

      while ((match = regexp.exec(content)) != null) {
        // const statement = match[0];
        // let vars;
        let mod;

        if (match[2]) {
          // vars = match[1];
          mod = match[2];
        } else {
          mod = match[1];
        }

        if (mod[0] === '.') {
          continue;
        }

        const parts = mod.split('/');

        if (parts.length === 1) {
          result.push({
            dep: mod,
            fileUrl
          });
        } else if (parts[0] === '@') {
          result.push({
            dep: parts.slice(0, 1).join('/'),
            fileUrl
          });
        } else {
          result.push({
            dep: parts[0],
            fileUrl
          });
        }
      }
    }
  }

  return result;
}

// @TODO: need a lot of tunning to find all possible variations (or find .babelrc or webpack configs)
function extractImportsFromAst(files) {
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');

    const ext = path.extname(file);
    const opts = {
      sourceType: 'unambiguous',
      presets: [],
      plugins: [
        'jsx',
        'classProperties',
        'objectRestSpread'
      ]
    };

    if (ext === '.ts' || ext === '.tsx') {
      opts.presets.push('typescript');
    }

    try {
      const ast = parser.parse(content, opts);
    } catch (err) {
      console.log(ext, file, err);
    }
  }
}

async function findAllSources(repoPath) {
  return globby(['**/*.{js,jsx,ts,tsx}'], {
    absolute: true,
    gitignore: true,
    cwd: repoPath
  });
}
