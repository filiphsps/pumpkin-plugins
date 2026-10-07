---
layout: page
sidebar: false
title: Team
description: Meet the people contributing to Pumpkin Plugins.
---

<script setup>
import { VPTeamPage, VPTeamPageTitle, VPTeamMembers } from 'vitepress/theme';
import { data as members } from './.vitepress/team.data.ts';
</script>

<VPTeamPage>
    <VPTeamPageTitle>
        <template #title>The people behind Pumpkin Plugins</template>
        <template #lead>
            Built by the community. Meet the contributors who help develop our plugins,
            tools, actions, and documentation.
        </template>
    </VPTeamPageTitle>
    <VPTeamMembers class="team-contributors" :members="members" />
</VPTeamPage>
