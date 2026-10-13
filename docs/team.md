---
layout: page
sidebar: false
title: Team
description: Meet the people contributing to pumpkin-plugins.
---

<script setup>
import { VPTeamPage, VPTeamPageTitle, VPTeamMembers } from 'vitepress/theme';
import { data as members } from './.vitepress/team.data.mts';
</script>

<VPTeamPage>
    <VPTeamPageTitle>
        <template #title>The people behind pumpkin-plugins</template>
        <template #lead>
            These contributors help develop our plugins, tools, actions, and documentation.
        </template>
    </VPTeamPageTitle>
    <VPTeamMembers class="team-contributors" :members="members" />
</VPTeamPage>
