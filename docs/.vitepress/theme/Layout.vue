<script lang="ts">
import DefaultTheme from 'vitepress/theme';
import { defineComponent, h } from 'vue';
import MegaNav from './MegaNav.vue';
import MobileNav from './MobileNav.vue';

export default defineComponent({
    setup(_props, { slots }) {
        return () => {
            const forwardedSlots = { ...slots };
            const navContentBefore = slots['nav-bar-content-before'];
            const screenContentBefore = slots['nav-screen-content-before'];
            forwardedSlots['nav-bar-content-before'] = () => [h(MegaNav), ...(navContentBefore?.() ?? [])];
            forwardedSlots['nav-screen-content-before'] = () => [h(MobileNav), ...(screenContentBefore?.() ?? [])];
            return h(DefaultTheme.Layout, null, forwardedSlots);
        };
    }
});
</script>
