# Project: animated-heatmap

## Git workflow

**After every push to the feature branch, always merge to main and push main.**

```
git checkout main
git merge <feature-branch>
git push origin main
git checkout <feature-branch>
```

Do this automatically — do not ask for confirmation first.

Feature branch: `claude/strava-heatmap-planning-60FNP`
