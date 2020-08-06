import { Util } from '../../global'
import { ObjectExt, StringExt, FunctionExt } from '../../util'
import { Rectangle, Angle, Point } from '../../geometry'
import { Cell } from '../../model/cell'
import { Node } from '../../model/node'
import { Edge } from '../../model/edge'
import { Model } from '../../model/model'
import { Collection } from '../../model/collection'
import { View } from '../../view/view'
import { CellView } from '../../view/cell'
import { Graph } from '../../graph/graph'
import { Renderer } from '../../graph/renderer'
import { Handle } from '../common'

export class Selection extends View<Selection.EventArgs> {
  public readonly options: Selection.Options
  protected readonly collection: Collection

  protected $container: JQuery<HTMLElement>
  protected $selectionContainer: JQuery<HTMLElement>
  protected $selectionContent: JQuery<HTMLElement>

  protected boxCount: number
  protected boxesUpdated: boolean

  public get graph() {
    return this.options.graph
  }

  protected get boxClassName() {
    return this.prefixClassName(Private.classNames.box)
  }

  protected get $boxes() {
    return this.$container.children(`.${this.boxClassName}`)
  }

  protected get handleOptions() {
    return this.options
  }

  constructor(options: Selection.Options) {
    super()
    this.options = ObjectExt.merge({}, Private.defaultOptions, options)

    if (this.options.model) {
      this.options.collection = this.options.model.collection
    }

    if (this.options.collection) {
      this.collection = this.options.collection
    } else {
      this.collection = new Collection([], {
        comparator: Private.depthComparator,
      })
      this.options.collection = this.collection
    }

    this.boxCount = 0

    this.createContainer()
    this.initHandles()
    this.startListening()
  }

  protected startListening() {
    const graph = this.graph
    const collection = this.collection

    this.delegateEvents(
      {
        [`mousedown .${this.boxClassName}`]: 'onSelectionBoxMouseDown',
        [`touchstart .${this.boxClassName}`]: 'onSelectionBoxMouseDown',
      },
      true,
    )

    graph.on('scale', this.onTransformed, this)
    graph.on('translate', this.onTransformed, this)

    collection.on('added', this.onCellAdded, this)
    collection.on('removed', this.onCellRemoved, this)
    collection.on('reseted', this.onReseted, this)
    collection.on('updated', this.onCollectionUpdated, this)
    collection.on('cell:change:*', this.onCellChanged, this)
  }

  protected stopListening() {
    const graph = this.graph
    const collection = this.collection

    this.undelegateEvents()

    graph.off('scale', this.onTransformed, this)
    graph.off('translate', this.onTransformed, this)

    collection.off('added', this.onCellAdded, this)
    collection.off('removed', this.onCellRemoved, this)
    collection.off('reseted', this.onReseted, this)
    collection.off('updated', this.onCollectionUpdated, this)
    collection.off('cell:change:*', this.onCellChanged, this)
  }

  protected onRemove() {
    this.stopListening()
  }

  protected onTransformed() {
    this.updateSelectionBoxes({ async: false })
  }

  protected onCellChanged() {
    this.updateSelectionBoxes()
  }

  isEmpty() {
    return this.length <= 0
  }

  isSelected(cell: Cell | string) {
    return this.collection.has(cell)
  }

  get length() {
    return this.collection.length
  }

  get cells() {
    return this.collection.toArray()
  }

  select(cells: Cell | Cell[], options: Collection.AddOptions = {}) {
    options.dryrun = true
    this.collection.add(cells, options)
    return this
  }

  unselect(cells: Cell | Cell[], options: Collection.RemoveOptions = {}) {
    // dryrun to prevent cell be removed from graph
    options.dryrun = true
    this.collection.remove(Array.isArray(cells) ? cells : [cells], options)
    return this
  }

  clean() {
    if (this.length) {
      this.collection.reset([], { ui: true })
    }
    return this
  }

  setFilter(filter?: Selection.Filter) {
    this.options.filter = filter
  }

  setContent(content?: Selection.Content) {
    this.options.content = content
  }

  startSelecting(evt: JQuery.MouseDownEvent) {
    // Flow: startSelecting => adjustSelection => stopSelecting

    evt = this.normalizeEvent(evt) // tslint:disable-line
    this.clean()
    let x
    let y
    const graphContainer = this.graph.container
    if (
      null != evt.offsetX &&
      null != evt.offsetY &&
      graphContainer.contains(evt.target)
    ) {
      x = evt.offsetX
      y = evt.offsetY
    } else {
      const offset = this.$(graphContainer).offset()!
      const scrollLeft = graphContainer.scrollLeft
      const scrollTop = graphContainer.scrollTop
      x = evt.clientX - offset.left + window.pageXOffset + scrollLeft
      y = evt.clientY - offset.top + window.pageYOffset + scrollTop
    }

    this.$container
      .css({
        width: 1,
        height: 1,
        left: x,
        top: y,
      })
      .appendTo(this.graph.container)

    this.showRubberband()
    this.setEventData<EventData.Selecting>(evt, {
      action: 'selecting',
      clientX: evt.clientX,
      clientY: evt.clientY,
      offsetX: x,
      offsetY: y,
    })
    this.delegateDocumentEvents(Private.documentEvents, evt.data)
  }

  protected stopSelecting(evt: JQuery.MouseUpEvent) {
    const graph = this.graph
    const action = this.getEventData<EventData.Common>(evt).action
    switch (action) {
      case 'selecting': {
        let width = this.$container.width()!
        let height = this.$container.height()!
        const offset = this.$container.offset()!
        const origin = graph.pageToLocalPoint(offset.left, offset.top)
        const scale = graph.scale()
        width = width / scale.sx
        height = height / scale.sy
        const rect = new Rectangle(origin.x, origin.y, width, height)
        let views = this.getNodesInArea(rect)
        const filter = this.options.filter

        if (Array.isArray(filter)) {
          views = views.filter(
            (view) =>
              !filter.includes(view.cell) && !filter.includes(view.cell.shape),
          )
        } else {
          if (typeof filter === 'function') {
            views = views.filter(
              (view) => !FunctionExt.call(filter, this.graph, view.cell),
            )
          }
        }
        const cells = views.map((view) => view.cell)
        this.collection.reset(cells, { ui: true })
        break
      }

      case 'translating': {
        this.graph.model.stopBatch('move-selection')
        const client = graph.snapToGrid(evt.clientX, evt.clientY)
        this.notifyBoxEvent('box:mouseup', evt, client.x, client.y)
        break
      }

      default: {
        if (!action) {
          this.clean()
        }
      }
    }
  }

  protected onMouseUp(evt: JQuery.MouseUpEvent) {
    const action = this.getEventData<EventData.Common>(evt).action
    if (action) {
      this.stopSelecting(evt)
      this.undelegateDocumentEvents()
    }
  }

  protected onSelectionBoxMouseDown(evt: JQuery.MouseDownEvent) {
    evt.stopPropagation()
    const e = this.normalizeEvent(evt)

    if (this.options.movable) {
      this.startTranslating(e)
    }

    const activeView = this.getCellViewFromElem(e.target)!
    this.setEventData<EventData.SelectionBox>(e, { activeView })
    const client = this.graph.snapToGrid(e.clientX, e.clientY)
    this.notifyBoxEvent('box:mousedown', e, client.x, client.y)
    this.delegateDocumentEvents(Private.documentEvents, e.data)
  }

  protected startTranslating(evt: JQuery.MouseDownEvent) {
    this.graph.model.startBatch('move-selection')
    const client = this.graph.snapToGrid(evt.clientX, evt.clientY)
    this.setEventData<EventData.Translating>(evt, {
      action: 'translating',
      clientX: client.x,
      clientY: client.y,
    })
  }

  protected adjustSelection(evt: JQuery.MouseMoveEvent) {
    const e = this.normalizeEvent(evt)
    const eventData = this.getEventData<EventData.Common>(e)
    const action = eventData.action
    switch (action) {
      case 'selecting': {
        const data = eventData as EventData.Selecting
        const dx = e.clientX - data.clientX
        const dy = e.clientY - data.clientY
        const left = parseInt(this.$container.css('left'), 10)
        const top = parseInt(this.$container.css('top'), 10)
        this.$container.css({
          left: dx < 0 ? data.offsetX + dx : left,
          top: dy < 0 ? data.offsetY + dy : top,
          width: Math.abs(dx),
          height: Math.abs(dy),
        })
        break
      }

      case 'translating': {
        const data = eventData as EventData.Translating
        const client = this.graph.snapToGrid(e.clientX, e.clientY)
        let dx = client.x - data.clientX
        let dy = client.y - data.clientY
        const restrict = this.graph.getRestrictArea()
        if (restrict) {
          const cells = this.collection.toArray()
          const totalBBox = Cell.getCellsBBox(cells)!
          const minDx = restrict.x - totalBBox.x
          const minDy = restrict.y - totalBBox.y
          const maxDx =
            restrict.x + restrict.width - (totalBBox.x + totalBBox.width)
          const maxDy =
            restrict.y + restrict.height - (totalBBox.y + totalBBox.height)
          if (dx < minDx) {
            dx = minDx
          }
          if (dy < minDy) {
            dy = minDy
          }
          if (maxDx < dx) {
            dx = maxDx
          }
          if (maxDy < dy) {
            dy = maxDy
          }
        }

        if (dx || dy) {
          if ((this.translateSelectedNodes(dx, dy), this.boxesUpdated)) {
            if (this.collection.length > 1) {
              this.updateSelectionBoxes()
            }
          } else {
            const scale = this.graph.scale()
            this.$boxes.add(this.$selectionContainer).css({
              left: `+=${dx * scale.sx}`,
              top: `+=${dy * scale.sy}`,
            })
          }
          data.clientX = client.x
          data.clientY = client.y
        }

        this.notifyBoxEvent('box:mousemove', evt, client.x, client.y)
        break
      }
    }
    this.boxesUpdated = false
  }

  protected translateSelectedNodes(dx: number, dy: number) {
    const map: { [id: string]: boolean } = {}
    this.collection.toArray().forEach((cell) => {
      if (!map[cell.id]) {
        const options = {
          selection: this.cid,
        }
        cell.translate(dx, dy, options)
        cell.getDescendants({ deep: true }).forEach((child) => {
          map[child.id] = true
        })
        this.graph.model.getConnectedEdges(cell).forEach((edge) => {
          if (!map[edge.id]) {
            edge.translate(dx, dy, options)
            map[edge.id] = true
          }
        })
      }
    })
  }

  protected getNodesInArea(rect: Rectangle) {
    const graph = this.graph
    const options = {
      strict: this.options.strict,
    }

    return this.options.useCellGeometry
      ? (graph.model
          .getNodesInArea(rect, options)
          .map((node) => graph.renderer.findViewByCell(node))
          .filter((view) => view != null) as CellView[])
      : graph.renderer.findViewsInArea(rect, options)
  }

  protected notifyBoxEvent<
    K extends keyof Selection.BoxEventArgs,
    T extends JQuery.TriggeredEvent
  >(name: K, e: T, x: number, y: number) {
    const data = this.getEventData<EventData.SelectionBox>(e)
    const view = data.activeView
    this.trigger(name, { e, view, x, y, cell: view.cell })
  }

  protected getSelectedClassName(cell: Cell) {
    return this.prefixClassName(`${cell.isNode() ? 'node' : 'edge'}-selected`)
  }

  protected addCellSelectedClassName(cell: Cell) {
    const view = this.graph.renderer.findViewByCell(cell)
    if (view) {
      view.addClass(this.getSelectedClassName(cell))
    }
  }

  protected removeCellUnSelectedClassName(cell: Cell) {
    const view = this.graph.renderer.findViewByCell(cell)
    if (view) {
      view.removeClass(this.getSelectedClassName(cell))
    }
  }

  protected destroySelectionBox(cell: Cell) {
    this.removeCellUnSelectedClassName(cell)

    if (this.canShowSelectionBox(cell)) {
      this.$container.find(`[data-cell="${cell.id}"]`).remove()
      if (this.$boxes.length === 0) {
        this.hide()
      }
      this.boxCount = Math.max(0, this.boxCount - 1)
    }
  }

  protected destroyAllSelectionBoxes(cells: Cell[]) {
    cells.forEach((cell) => this.removeCellUnSelectedClassName(cell))

    this.hide()
    this.$boxes.remove()
    this.boxCount = 0
  }

  hide() {
    this.$container
      .removeClass(this.prefixClassName(Private.classNames.rubberband))
      .removeClass(this.prefixClassName(Private.classNames.selected))
  }

  protected showRubberband() {
    this.$container.addClass(
      this.prefixClassName(Private.classNames.rubberband),
    )
  }

  protected showSelected() {
    this.$container
      .removeAttr('style')
      .addClass(this.prefixClassName(Private.classNames.selected))
  }

  protected createContainer() {
    this.container = document.createElement('div')
    this.$container = this.$(this.container)
    this.$container.addClass(this.prefixClassName(Private.classNames.root))
    if (this.options.className) {
      this.$container.addClass(this.options.className)
    }

    this.$selectionContainer = this.$('<div/>').addClass(
      this.prefixClassName(Private.classNames.inner),
    )

    this.$selectionContent = this.$('<div/>').addClass(
      this.prefixClassName(Private.classNames.content),
    )

    this.$selectionContainer.append(this.$selectionContent)
    this.$selectionContainer.attr(
      'data-selection-length',
      this.collection.length,
    )

    this.$container.prepend(this.$selectionContainer)
    this.$handleContainer = this.$selectionContainer
  }

  protected updateContainer() {
    const origin = { x: Infinity, y: Infinity }
    const corner = { x: 0, y: 0 }
    const cells = this.collection
      .toArray()
      .filter((cell) => this.canShowSelectionBox(cell))

    cells.forEach((cell) => {
      const view = this.graph.renderer.findViewByCell(cell)
      if (view) {
        const bbox = view.getBBox({
          useCellGeometry: this.options.useCellGeometry,
        })
        origin.x = Math.min(origin.x, bbox.x)
        origin.y = Math.min(origin.y, bbox.y)
        corner.x = Math.max(corner.x, bbox.x + bbox.width)
        corner.y = Math.max(corner.y, bbox.y + bbox.height)
      }
    })

    this.$selectionContainer
      .css({
        position: 'absolute',
        pointerEvents: 'none',
        left: origin.x,
        top: origin.y,
        width: corner.x - origin.x,
        height: corner.y - origin.y,
      })
      .attr('data-selection-length', this.collection.length)

    const boxContent = this.options.content
    if (boxContent) {
      if (typeof boxContent === 'function') {
        const content = FunctionExt.call(
          boxContent,
          this.graph,
          this,
          this.$selectionContent[0],
        )
        if (content) {
          this.$selectionContent.html(content)
        }
      } else {
        this.$selectionContent.html(boxContent)
      }
    }

    if (this.collection.length > 0 && !this.container.parentNode) {
      this.$container.appendTo(this.graph.container)
    } else if (this.collection.length <= 0 && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container)
    }
  }

  protected canShowSelectionBox(cell: Cell) {
    return (
      (cell.isNode() && this.options.showNodeSelectionBox === true) ||
      (cell.isEdge() && this.options.showEdgeSelectionBox === true)
    )
  }

  protected createSelectionBox(cell: Cell) {
    this.addCellSelectedClassName(cell)

    if (this.canShowSelectionBox(cell)) {
      const view = this.graph.renderer.findViewByCell(cell)
      if (view) {
        const bbox = view.getBBox({
          useCellGeometry: this.options.useCellGeometry,
        })

        const className = this.boxClassName
        this.$('<div/>')
          .addClass(className)
          .addClass(`${className}-${cell.isNode() ? 'node' : 'edge'}`)
          .attr('data-cell', cell.id)
          .css({
            position: 'absolute',
            left: bbox.x,
            top: bbox.y,
            width: bbox.width,
            height: bbox.height,
          })
          .appendTo(this.container)
        this.showSelected()
        this.boxCount += 1
      }
    }
  }

  protected updateSelectionBoxes(
    options: Renderer.RequestViewUpdateOptions = {},
  ) {
    if (this.collection.length > 0) {
      this.boxesUpdated = true
      this.graph.renderer.requestViewUpdate(this as any, 1, 2, options)
    }
  }

  confirmUpdate() {
    if (this.boxCount) {
      this.hide()
      this.$boxes.each((_, elem) => {
        const cellId = this.$(elem).remove().attr('data-cell')
        const cell = this.collection.get(cellId)
        if (cell) {
          this.createSelectionBox(cell)
        }
      })

      this.updateContainer()
    }
    return 0
  }

  protected getCellViewFromElem(elem: Element) {
    const id = elem.getAttribute('data-cell')
    if (id) {
      const cell = this.collection.get(id)
      if (cell) {
        return this.graph.renderer.findViewByCell(cell)
      }
    }
    return null
  }

  protected onCellRemoved({ cell }: Collection.EventArgs['removed']) {
    this.destroySelectionBox(cell)
    this.updateContainer()
  }

  protected onReseted({ previous, current }: Collection.EventArgs['reseted']) {
    this.destroyAllSelectionBoxes(previous)
    current.forEach((cell) => {
      this.listenCellRemoveEvent(cell)
      this.createSelectionBox(cell)
    })
    this.updateContainer()
  }

  protected onCellAdded({ cell }: Collection.EventArgs['added']) {
    // The collection do not known the cell was removed when cell was
    // removed by interaction(such as, by "delete" shortcut), so we should
    // manually listen to cell's remove evnet.
    this.listenCellRemoveEvent(cell)
    this.createSelectionBox(cell)
    this.updateContainer()
  }

  protected listenCellRemoveEvent(cell: Cell) {
    cell.off('removed', this.onCellRemoved, this)
    cell.on('removed', this.onCellRemoved, this)
  }

  protected onCollectionUpdated({
    added,
    removed,
    options,
  }: Collection.EventArgs['updated']) {
    added.forEach((cell) => {
      this.trigger('cell:selected', { cell, options })
      this.graph.trigger('cell:selected', { cell, options })
      if (cell.isNode()) {
        this.trigger('node:selected', { cell, options, node: cell })
        this.graph.trigger('node:selected', { cell, options, node: cell })
      } else if (cell.isEdge()) {
        this.trigger('edge:selected', { cell, options, edge: cell })
        this.graph.trigger('edge:selected', { cell, options, edge: cell })
      }
    })

    removed.forEach((cell) => {
      this.trigger('cell:unselected', { cell, options })
      this.graph.trigger('cell:unselected', { cell, options })
      if (cell.isNode()) {
        this.trigger('node:unselected', { cell, options, node: cell })
        this.graph.trigger('node:unselected', { cell, options, node: cell })
      } else if (cell.isEdge()) {
        this.trigger('edge:unselected', { cell, options, edge: cell })
        this.graph.trigger('edge:unselected', { cell, options, edge: cell })
      }
    })

    const args = {
      added,
      removed,
      options,
      selected: this.cells,
    }
    this.trigger('selection:changed', args)
    this.graph.trigger('selection:changed', args)
  }

  // #region handle

  protected deleteSelectedCells() {
    const cells = this.collection.toArray()
    this.clean()
    this.graph.model.removeCells(cells, {
      selection: this.cid,
    })
  }

  protected startRotate({ e }: Handle.EventArgs) {
    const cells = this.collection.toArray()
    const center = Cell.getCellsBBox(cells)!.getCenter()
    const client = this.graph.snapToGrid(e.clientX!, e.clientY!)
    const angles = cells.reduce<{ [id: string]: number }>(
      (memo, cell: Node) => {
        memo[cell.id] = Angle.normalize(cell.getAngle())
        return memo
      },
      {},
    )

    this.setEventData<EventData.Rotation>(e, {
      center,
      angles,
      start: client.theta(center),
    })
  }

  protected doRotate({ e }: Handle.EventArgs) {
    const data = this.getEventData<EventData.Rotation>(e)
    const grid = this.graph.options.rotating.grid
    const gridSize =
      typeof grid === 'function'
        ? FunctionExt.call(grid, this.graph, null as any)
        : grid
    const client = this.graph.snapToGrid(e.clientX!, e.clientY!)
    const delta = data.start - client.theta(data.center)

    if (Math.abs(delta) > 0.001) {
      this.collection.toArray().forEach((node: Node) => {
        const angle = Util.snapToGrid(
          data.angles[node.id] + delta,
          gridSize || 15,
        )
        node.rotate(angle, {
          absolute: true,
          center: data.center,
          selection: this.cid,
        })
      })
      this.updateSelectionBoxes()
    }
  }

  protected stopRotate() {}

  protected startResize({ e }: Handle.EventArgs) {
    const gridSize = this.graph.getGridSize()
    const cells = this.collection.toArray()
    const bbox = Cell.getCellsBBox(cells)!
    const bboxes = cells.map((cell) => cell.getBBox())
    const maxWidth = bboxes.reduce((maxWidth, bbox) => {
      return bbox.width < maxWidth ? bbox.width : maxWidth
    }, Infinity)
    const maxHeight = bboxes.reduce((maxHeight, bbox) => {
      return bbox.height < maxHeight ? bbox.height : maxHeight
    }, Infinity)

    this.setEventData<EventData.Resizing>(e, {
      bbox,
      cells: this.graph.model.getSubGraph(cells),
      minWidth: (gridSize * bbox.width) / maxWidth,
      minHeight: (gridSize * bbox.height) / maxHeight,
    })
  }

  protected doResize({ e, dx, dy }: Handle.EventArgs) {
    const data = this.eventData<EventData.Resizing>(e)
    const bbox = data.bbox
    const width = bbox.width
    const height = bbox.height
    const newWidth = Math.max(width + dx, data.minWidth)
    const newHeight = Math.max(height + dy, data.minHeight)
    if (
      0.001 < Math.abs(width - newWidth) ||
      0.001 < Math.abs(height - newHeight)
    ) {
      this.graph.model.resizeCells(newWidth, newHeight, data.cells, {
        selection: this.cid,
      })
      bbox.width = newWidth
      bbox.height = newHeight
      this.updateSelectionBoxes()
    }
  }

  protected stopResize() {}

  // #endregion
}

export namespace Selection {
  export interface CommonOptions extends Handle.Options {
    model?: Model
    collection?: Collection
    className?: string
    strict?: boolean
    filter?: Filter

    showEdgeSelectionBox?: boolean
    showNodeSelectionBox?: boolean
    movable?: boolean
    useCellGeometry?: boolean
    content?: Content
  }

  export interface Options extends CommonOptions {
    graph: Graph
  }

  export type Content =
    | null
    | false
    | string
    | ((
        this: Graph,
        selection: Selection,
        contentElement: HTMLElement,
      ) => string)

  export type Filter =
    | null
    | (string | { id: string })[]
    | ((this: Graph, cell: Cell) => boolean)
}

export namespace Selection {
  interface SelectionBoxEventArgs<T> {
    e: T
    view: CellView
    cell: Cell
    x: number
    y: number
  }

  export interface BoxEventArgs {
    'box:mousedown': SelectionBoxEventArgs<JQuery.MouseDownEvent>
    'box:mousemove': SelectionBoxEventArgs<JQuery.MouseMoveEvent>
    'box:mouseup': SelectionBoxEventArgs<JQuery.MouseUpEvent>
  }

  export interface SelectionEventArgs {
    'cell:selected': { cell: Cell; options: Model.SetOptions }
    'node:selected': { cell: Cell; node: Node; options: Model.SetOptions }
    'edge:selected': { cell: Cell; edge: Edge; options: Model.SetOptions }
    'cell:unselected': { cell: Cell; options: Model.SetOptions }
    'node:unselected': { cell: Cell; node: Node; options: Model.SetOptions }
    'edge:unselected': { cell: Cell; edge: Edge; options: Model.SetOptions }
    'selection:changed': {
      added: Cell[]
      removed: Cell[]
      selected: Cell[]
      options: Model.SetOptions
    }
  }

  export interface EventArgs extends BoxEventArgs, SelectionEventArgs {}
}

export interface Selection extends Handle {}

ObjectExt.applyMixins(Selection, Handle)

// private
// -------
namespace Private {
  const base = 'widget-selection'

  export const classNames = {
    root: base,
    inner: `${base}-inner`,
    box: `${base}-box`,
    content: `${base}-content`,
    rubberband: `${base}-rubberband`,
    selected: `${base}-selected`,
  }

  export const documentEvents = {
    mousemove: 'adjustSelection',
    touchmove: 'adjustSelection',
    mouseup: 'onMouseUp',
    touchend: 'onMouseUp',
    touchcancel: 'onMouseUp',
  }

  export const defaultOptions: Partial<Selection.Options> = {
    movable: true,
    strict: false,
    useCellGeometry: false,
    content(selection) {
      return StringExt.template(
        '<%= length %> node<%= length > 1 ? "s":"" %> selected.',
      )({ length: selection.length })
    },
    handles: [
      {
        name: 'remove',
        position: 'nw',
        events: {
          mousedown: 'deleteSelectedCells',
        },
      },
      {
        name: 'rotate',
        position: 'sw',
        events: {
          mousedown: 'startRotate',
          mousemove: 'doRotate',
          mouseup: 'stopRotate',
        },
      },
      {
        name: 'resize',
        position: 'se',
        events: {
          mousedown: 'startResize',
          mousemove: 'doResize',
          mouseup: 'stopResize',
        },
      },
    ],
  }

  export function depthComparator(cell: Cell) {
    return cell.getAncestors().length
  }
}

namespace EventData {
  export interface Common {
    action: 'selecting' | 'translating'
  }

  export interface Selecting extends Common {
    action: 'selecting'
    clientX: number
    clientY: number
    offsetX: number
    offsetY: number
  }

  export interface Translating extends Common {
    action: 'translating'
    clientX: number
    clientY: number
  }

  export interface SelectionBox {
    activeView: CellView
  }

  export interface Rotation {
    center: Point.PointLike
    start: number
    angles: { [id: string]: number }
  }

  export interface Resizing {
    bbox: Rectangle
    cells: Cell[]
    minWidth: number
    minHeight: number
  }
}
