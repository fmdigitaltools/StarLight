import { t } from '@shared/i18n/i18n'
import { requiredStars, type AlignmentResult } from '@core/stack/alignment'
import type { Star } from '@core/stars/detection'
import { alignmentWorkerPool } from './pool'

/**
 * Alignment distributed across the workers.
 *
 * Computed here, on the UI thread, aligning three hundred frames takes
 * almost eight seconds with the window frozen. But each frame is compared
 * only with the reference, never with the others: the frames can therefore
 * be handed to several workers at once, and each result is identical to
 * the single-thread computation, because the procedure contains nothing
 * random.
 *
 * Only the stars that the alignment actually reads are sent to the
 * workers: a few dozen per frame instead of thousands.
 */
export async function alignParallel(
  reference: Star[],
  frameStars: Star[][],
  progress?: (fraction: number) => void
): Promise<AlignmentResult[]> {
  if (frameStars.length === 0) return []

  const workerPool = alignmentWorkerPool()
  const referenceStars = requiredStars(reference)

  let completedItems = 0
  const responses = await Promise.all(
    frameStars.map((stars, i) =>
      workerPool
        .align({ id: i, reference: referenceStars, stars: requiredStars(stars) })
        .then((response) => {
          completedItems++
          if (progress) progress(completedItems / frameStars.length)
          return response
        })
    )
  )

  return responses.map((response) => {
    if (response.status === 'error' || !response.result) {
      throw new Error(response.message ?? t('workersAlignParallel.failed'))
    }
    return response.result
  })
}
