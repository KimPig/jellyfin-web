import { PlaybackManager } from './playbackmanager';
import { TICKS_PER_MILLISECOND, TICKS_PER_SECOND } from 'constants/time';
import type { MediaSegmentDto } from '@jellyfin/sdk/lib/generated-client/models/media-segment-dto';
import type { PlaybackStopInfo } from 'types/playbackStopInfo';
import { PlaybackSubscriber } from 'apps/legacy/features/playback/utils/playbackSubscriber';
import { isInSegment } from 'apps/legacy/features/playback/utils/mediaSegments';
import Events, { type Event } from 'utils/events';
import { EventType } from 'constants/eventType';
import './skipbutton.scss';
import dom from 'utils/dom';
import globalize from 'lib/globalize';
import focusManager from 'components/focusManager';
import layoutManager from 'components/layoutManager';

interface ShowOptions {
    animate?: boolean;
    keep?: boolean;
    focus?: boolean;
}

function onHideComplete(this: HTMLButtonElement) {
    if (this) {
        // Handle focus after the hide transition completes
        if (document.activeElement === this) {
            this.blur();
            const pauseButton = document.querySelector('.btnPause');
            if (pauseButton && focusManager.isCurrentlyFocusable(pauseButton)) {
                focusManager.focus(pauseButton);
            }
        }

        this.classList.add('hide');
    }
}

class SkipSegment extends PlaybackSubscriber {
    private skipElement: HTMLButtonElement | null;
    private currentSegment: MediaSegmentDto | null | undefined;
    private hideTimeout: ReturnType<typeof setTimeout> | null | undefined;
    private upNextContainer: HTMLElement | null = null;
    private upNextObserver: MutationObserver | null = null;
    private upNextResizeObserver: ResizeObserver | null = null;

    constructor(playbackManager: PlaybackManager) {
        super(playbackManager);

        this.skipElement = null;
        this.onOsdChanged = this.onOsdChanged.bind(this);
        this.updateSkipButtonPosition = this.updateSkipButtonPosition.bind(this);
    }

    createSkipElement() {
        if (!this.skipElement && this.currentSegment) {
            let buttonHtml = '';

            // FIXME: Move skip button to the video OSD
            buttonHtml += '<div class="skip-button-container"><button is="emby-button" class="skip-button hide skip-button-hidden"></button></div>';

            document.body.insertAdjacentHTML('beforeend', buttonHtml);

            this.skipElement = document.body.querySelector('.skip-button');
            if (this.skipElement) {
                this.skipElement.addEventListener('click', () => {
                    const time = this.playbackManager.currentTime() * TICKS_PER_MILLISECOND;
                    if (this.currentSegment?.EndTicks) {
                        if (time < this.currentSegment.EndTicks - TICKS_PER_SECOND) {
                            this.playbackManager.seek(this.currentSegment.EndTicks);
                        } else {
                            this.hideSkipButton();
                        }
                    }
                });
                this.observeUpNextDialog();
            }
        }
    }

    private observeUpNextDialog() {
        const upNextContainer = document.querySelector<HTMLElement>('.upNextContainer');
        if (this.upNextContainer === upNextContainer) {
            this.updateSkipButtonPosition();
            return;
        }

        this.upNextObserver?.disconnect();
        this.upNextResizeObserver?.disconnect();
        window.removeEventListener('resize', this.updateSkipButtonPosition);
        this.upNextContainer = upNextContainer;

        if (!upNextContainer) {
            this.updateSkipButtonPosition();
            return;
        }

        this.upNextObserver = new MutationObserver(this.updateSkipButtonPosition);
        this.upNextObserver.observe(upNextContainer, {
            attributes: true,
            attributeFilter: [ 'class' ],
            childList: true,
            subtree: true
        });
        this.upNextResizeObserver = new ResizeObserver(this.updateSkipButtonPosition);
        this.upNextResizeObserver.observe(upNextContainer);
        window.addEventListener('resize', this.updateSkipButtonPosition);
        this.updateSkipButtonPosition();
    }

    private updateSkipButtonPosition() {
        const skipContainer = this.skipElement?.closest<HTMLElement>('.skip-button-container');
        const upNextContainer = this.upNextContainer;
        if (!skipContainer || !upNextContainer || !this.currentSegment
            || upNextContainer.classList.contains('hide')
            || upNextContainer.classList.contains('upNextDialog-hidden')) {
            skipContainer?.classList.remove('skip-button-container-up-next');
            skipContainer?.style.removeProperty('--skip-button-bottom');
            return;
        }

        const bounds = upNextContainer.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) {
            return;
        }

        const gap = 16;
        const defaultBottom = 8 * 16;
        const bottom = Math.max(defaultBottom, window.innerHeight - bounds.top + gap);
        skipContainer.style.setProperty('--skip-button-bottom', `${Math.ceil(bottom)}px`);
        skipContainer.classList.add('skip-button-container-up-next');
    }

    setButtonText() {
        if (this.skipElement && this.currentSegment) {
            this.skipElement.innerHTML = globalize.translate('MediaSegmentSkipPrompt', globalize.translate(`MediaSegmentType.${this.currentSegment.Type}`));
            this.skipElement.innerHTML += '<span class="material-icons skip_next" aria-hidden="true"></span>';
        }
    }

    showSkipButton(options: ShowOptions) {
        const elem = this.skipElement;
        if (elem) {
            this.clearHideTimeout();
            dom.removeEventListener(elem, dom.whichTransitionEvent(), onHideComplete, {
                once: true
            });
            elem.classList.remove('hide');
            if (!options.animate) {
                elem.classList.add('no-transition');
            } else {
                elem.classList.remove('no-transition');
            }

            // eslint-disable-next-line sonarjs/void-use
            void elem.offsetWidth;

            const hasFocus = document.activeElement && focusManager.isCurrentlyFocusable(document.activeElement);
            if (options.focus && !hasFocus) {
                focusManager.focus(elem);
            }

            requestAnimationFrame(() => {
                this.updateSkipButtonPosition();
                elem.classList.remove('skip-button-hidden');

                if (!options.keep) {
                    this.hideTimeout = setTimeout(this.hideSkipButton.bind(this), 8000);
                }
            });
        }
    }

    hideSkipButton() {
        const elem = this.skipElement;
        if (elem) {
            elem.classList.remove('no-transition');
            // eslint-disable-next-line sonarjs/void-use
            void elem.offsetWidth;

            requestAnimationFrame(() => {
                elem.classList.add('skip-button-hidden');

                dom.addEventListener(elem, dom.whichTransitionEvent(), onHideComplete, {
                    once: true
                });
            });
        }
    }

    clearHideTimeout() {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    onOsdChanged(_e: Event, isOpen: boolean) {
        if (this.currentSegment) {
            if (isOpen) {
                this.showSkipButton({
                    animate: false,
                    keep: true,
                    focus: false
                });
            } else if (!this.hideTimeout) {
                this.hideSkipButton();
            }
        }
    }

    onPromptSkip(e: Event, segment: MediaSegmentDto) {
        if (!this.currentSegment) {
            this.currentSegment = segment;

            this.createSkipElement();

            this.setButtonText();

            this.showSkipButton({
                animate: true,
                focus: layoutManager.tv
            });
        }
    }

    onPlayerTimeUpdate() {
        if (this.currentSegment) {
            const time = this.playbackManager.currentTime(this.player) * TICKS_PER_MILLISECOND;

            if (!isInSegment(this.currentSegment, time)) {
                this.currentSegment = null;
                this.hideSkipButton();
            }
        }
    }

    onPlayerChange(): void {
        if (this.playbackManager.getCurrentPlayer()) {
            Events.off(document, EventType.SHOW_VIDEO_OSD, this.onOsdChanged);
            Events.on(document, EventType.SHOW_VIDEO_OSD, this.onOsdChanged);
            this.observeUpNextDialog();
        }
    }

    onPlaybackStop(_e: Event, playbackStopInfo: PlaybackStopInfo) {
        this.currentSegment = null;
        this.hideSkipButton();
        if (!playbackStopInfo.nextItem) {
            Events.off(document, EventType.SHOW_VIDEO_OSD, this.onOsdChanged);
        }
    }
}

export const bindSkipSegment = (playbackManager: PlaybackManager) => new SkipSegment(playbackManager);
