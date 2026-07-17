const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const http = require('http');
const PDFDocument = require('pdfkit');

// 1. Validar configuraciones
if (!process.env.TELEGRAM_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ Error crítico: Faltan configuraciones en el archivo .env");
    process.exit(1);
}

console.log("✅ Configuraciones cargadas correctamente");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// 2. Función maestra para formato moneda
const fmt = (n) => `S/. ${parseFloat(n || 0).toFixed(2)}`;

// 3. Función para formatear números
const formatearNumero = (valor) => {
    if (isNaN(valor)) return 0;
    return parseFloat(parseFloat(valor).toFixed(2));
};

// 4. Función para calcular precio sugerido por cantidad
function calcularPrecioSugerido(precioOriginal, cantidad, costo) {
    const MARGEN_GANANCIA = 1.30;
    let descuentoVolumen = 0;
    
    if (cantidad >= 100) {
        descuentoVolumen = 0.25;
    } else if (cantidad >= 50) {
        descuentoVolumen = 0.20;
    } else if (cantidad >= 25) {
        descuentoVolumen = 0.15;
    } else if (cantidad >= 10) {
        descuentoVolumen = 0.10;
    } else if (cantidad >= 5) {
        descuentoVolumen = 0.05;
    }
    
    let precioSugerido = (costo * MARGEN_GANANCIA) * (1 - descuentoVolumen);
    
    if (precioSugerido < costo) {
        precioSugerido = costo * 1.05;
    }
    if (precioSugerido > precioOriginal) {
        precioSugerido = precioOriginal * 0.95;
    }
    
    return formatearNumero(precioSugerido);
}

// 5. Gestión de estados
const estados = {};
function getEstado(userId) {
    if (!estados[userId]) {
        estados[userId] = { 
            esperando: null, 
            resultadosBusqueda: null, 
            carrito: [], 
            autenticado: false, 
            rol: null, 
            temp: null,
            paginaActual: 1,
            totalPaginas: 1,
            descuentoGlobal: null
        };
    }
    return estados[userId];
}

// 6. Función para limpiar completamente el estado del carrito
function limpiarCarrito(estado) {
    estado.carrito = [];
    estado.resultadosBusqueda = null;
    estado.esperando = null;
    estado.temp = null;
    estado.descuentoGlobal = null;
}

// 7. Función para mostrar productos en UNA SOLA LÍNEA
function mostrarProducto(producto, index = null) {
    const prefix = index !== null ? `${index + 1}.` : '';
    const nombre = producto.nombre || 'Sin nombre';
    const stock = producto.stock || 0;
    const seccion = producto.seccion ? `📍${producto.seccion}` : '📦';
    const precioCosto = parseFloat(producto.precio_costo || 0).toFixed(2);
    const precioVenta = parseFloat(producto.precio_venta || 0).toFixed(2);
    
    return `${prefix} ${nombre} 📦${stock} ${seccion} 💰${precioCosto} 💲${precioVenta}\n`;
}

// 8. Función de paginación optimizada
function mostrarPaginaProductos(ctx, productos, pagina, esBusqueda = false) {
    const itemsPorPagina = 5;
    const totalPaginas = Math.ceil(productos.length / itemsPorPagina);
    const inicio = (pagina - 1) * itemsPorPagina;
    const fin = Math.min(inicio + itemsPorPagina, productos.length);
    const paginaProductos = productos.slice(inicio, fin);
    
    let respuesta = "📋 **PRODUCTOS**\n";
    respuesta += `📄 Pág ${pagina}/${totalPaginas} | ${productos.length} items\n`;
    respuesta += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    
    paginaProductos.forEach((prod, index) => {
        const num = inicio + index + 1;
        const nombre = prod.nombre || 'Sin nombre';
        const stock = prod.stock || 0;
        const seccion = prod.seccion ? `📍${prod.seccion}` : '📦';
        const costo = parseFloat(prod.precio_costo || 0).toFixed(2);
        const venta = parseFloat(prod.precio_venta || 0).toFixed(2);
        
        respuesta += `${num}. ${nombre} 📦${stock} ${seccion} 💰${costo} 💲${venta}\n`;
        respuesta += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    });
    
    if (esBusqueda) {
        respuesta += `\n✏️ N° y cantidad (ej: 1,3) | precio 20 | desc 10 | sugerido`;
    } else {
        respuesta += `\n✏️ N° y cantidad (ej: 1,3)`;
    }
    
    const keyboard = {
        inline_keyboard: []
    };
    
    const navRow = [];
    if (pagina > 1) navRow.push({ text: "◀️ Anterior", callback_data: `pagina_${pagina-1}` });
    if (pagina < totalPaginas) navRow.push({ text: "Siguiente ▶️", callback_data: `pagina_${pagina+1}` });
    if (navRow.length > 0) keyboard.inline_keyboard.push(navRow);

    if (esBusqueda) {
        keyboard.inline_keyboard.push([
            { text: "🛒 Ver Carrito", callback_data: "ver_carrito" },
            { text: "🏠 Menú", callback_data: "menu_principal" }
        ]);
    }
    
    const estado = getEstado(ctx.from.id);
    estado.paginaActual = pagina;
    estado.totalPaginas = totalPaginas;
    
    return ctx.reply(respuesta, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

// 9. Función para mostrar carrito optimizado
function mostrarCarrito(ctx, estado) {
    let r = "🛒 **CARRITO**\n";
    let total = 0;
    let totalOriginal = 0;
    let totalAhorro = 0;
    
    if (!estado.carrito || estado.carrito.length === 0) {
        return ctx.reply("🛒 El carrito está vacío.");
    }
    
    r += `📦 ${estado.carrito.length} items\n`;
    r += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    
    estado.carrito.forEach((item, index) => {
        const sub = item.precio * item.cantidad;
        const subOriginal = (item.precioOriginal || item.precio) * item.cantidad;
        total += sub;
        totalOriginal += subOriginal;
        totalAhorro += (subOriginal - sub);
        
        const precioUnitario = parseFloat(item.precio).toFixed(2);
        const subtotal = parseFloat(sub).toFixed(2);
        
        r += `${index + 1}. ${item.nombre} x${item.cantidad}`;
        if (item.descuentoPorcentaje > 0) {
            r += ` (${item.descuentoPorcentaje}% desc)`;
        }
        if (item.precioPersonalizado) {
            r += ` ⚠️P${precioUnitario}`;
        }
        r += ` 💲${subtotal}\n`;
        r += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    });
    
    const totalFinal = parseFloat(total).toFixed(2);
    r += `💰 Total: ${totalFinal}`;
    if (totalAhorro > 0) {
        const ahorroFinal = parseFloat(totalAhorro).toFixed(2);
        r += ` | 💵 Ahorro: ${ahorroFinal}`;
    }
    r += `\n\n**Selecciona:**`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "✏️ Editar Precio", callback_data: "editar_precio_carrito" }, { text: "🏷️ Descuento Global", callback_data: "descuento_global" }],
            [{ text: "💵 Efectivo", callback_data: "pago_Efectivo" }, { text: "💳 Tarjeta", callback_data: "pago_Tarjeta" }],
            [{ text: "📱 Transferencia", callback_data: "pago_Transferencia" }],
            [{ text: "🔍 Seguir Comprando", callback_data: "volver_busqueda" }, { text: "🗑️ Vaciar", callback_data: "vaciar_carrito" }],
            [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
        ]
    };
    
    return ctx.reply(r, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

// 10. Función para mostrar el menú principal con botones
function mostrarMenuPrincipal(ctx) {
    const estado = getEstado(ctx.from.id);
    
    if (estado.autenticado) {
        limpiarCarrito(estado);
    }
    
    let mensaje = "🏪 **Sistema POS Ferretero**\n\n";
    
    if (!estado.autenticado) {
        mensaje += "🔐 **ACCESO RESTRINGIDO**\n";
        mensaje += "Por favor, introduce tu PIN de acceso.\n\n";
        mensaje += "⚠️ *Este sistema es de uso exclusivo para personal autorizado.*";
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔐 Iniciar Sesión", callback_data: "iniciar_sesion" }]
            ]
        };
        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });
    }
    
    mensaje += `👋 Bienvenido, *${estado.rol}*\n\n`;
    mensaje += "📌 **Selecciona una opción:**";
    
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔍 Buscar Productos", callback_data: "buscar_productos" }],
            [{ text: "📊 Ver Inventario", callback_data: "ver_inventario" }],
            [{ text: "🛒 Ver Carrito", callback_data: "ver_carrito" }],
            [{ text: "🗑️ Vaciar Carrito", callback_data: "vaciar_carrito" }]
        ]
    };
    
    if (estado.rol === 'ADMINISTRADOR') {
        keyboard.inline_keyboard.push([
            { text: "➕ Agregar Producto", callback_data: "agregar_producto" },
            { text: "✏️ Editar Producto", callback_data: "editar_producto" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "💰 Ganancias", callback_data: "ver_ganancias" },
            { text: "🔔 Alertas Stock", callback_data: "ver_alertas" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "📦 Registrar Compra", callback_data: "registrar_compra" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "📊 Reporte Movimientos", callback_data: "reporte_movimientos" },
            { text: "📈 Resumen Inventario", callback_data: "resumen_inventario" }
        ]);
        keyboard.inline_keyboard.push([
            { text: "🔍 Movimientos x Producto", callback_data: "movimientos_producto" }
        ]);
    }
    
    keyboard.inline_keyboard.push([{ text: "❌ Cerrar Sesión", callback_data: "cerrar_sesion" }]);
    
    return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });
}

// ==========================================
// FUNCIÓN PARA GENERAR TICKET PDF (BLANCO Y NEGRO, SOLO LÍNEAS)
// ==========================================
async function generarTicketVenta(datosVenta) {
    return new Promise((resolve, reject) => {
        try {
            // Tamaño estándar para ticket
            const doc = new PDFDocument({
                size: [280, 500],
                margin: 10,
                layout: 'portrait'
            });
            
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });
            // CRÍTICO: sin este listener, un error del stream de PDFKit nunca
            // rechaza ni resuelve la promesa -> la venta se queda "colgada"
            // esperando la boleta para siempre (parecía que "fallaba" sin dar error).
            doc.on('error', (err) => {
                reject(err);
            });
            
            // --- CONFIGURACIÓN DE MÁRGENES ---
            const pageWidth = 260;
            const centerX = 140;
            let yPos = 10;
            
            // --- FUNCIÓN PARA DIBUJAR LÍNEA SEPARADORA ---
            function drawLine() {
                doc.moveTo(15, doc.y);
                doc.lineTo(265, doc.y);
                doc.lineWidth(0.5);
                doc.stroke();
                doc.moveDown(0.3);
            }
            
            // --- FUNCIÓN PARA CENTRAR TEXTO ---
            function centerText(text, fontSize = 9, font = 'Helvetica', bold = false) {
                doc.fontSize(fontSize);
                doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
                doc.text(text, 10, doc.y, {
                    width: pageWidth,
                    align: 'center'
                });
                doc.moveDown(0.2);
            }
            
            // ==========================================
            // 1. ENCABEZADO DE LA TIENDA
            // ==========================================
            doc.fillColor('#1a1a1a');
            doc.fontSize(14).font('Helvetica-Bold');
            centerText('"EYMI E"', 14, 'Helvetica-Bold', true);
            
            doc.fontSize(9).font('Helvetica');
            centerText('Jr. Huayata N° 405', 9);
            centerText('Ayacucho', 9);
            centerText('Tel: 987-654-321', 9);
            
            drawLine();
            
            // ==========================================
            // 2. DATOS DEL CLIENTE Y VENTA
            // ==========================================
            doc.fillColor('#1a1a1a');
            doc.fontSize(9).font('Helvetica-Bold');
            centerText('DATOS DE LA VENTA', 9, 'Helvetica-Bold', true);
            
            doc.fontSize(8).font('Helvetica');
            centerText(`CLIENTE: ${datosVenta.cliente || '___________________'}`, 8);
            centerText(`DNI/RUC: ${datosVenta.dni || '___________________'}`, 8);
            centerText(`FECHA: ${new Date().toLocaleString()}`, 8);
            centerText(`ATENDIDO POR: ${datosVenta.vendedor || '___________________'}`, 8);
            
            drawLine();
            
            // ==========================================
            // 3. DETALLE DE PRODUCTOS
            // ==========================================
            doc.fillColor('#1a1a1a');
            doc.fontSize(9).font('Helvetica-Bold');
            centerText('DETALLE DE PRODUCTOS', 9, 'Helvetica-Bold', true);
            
            // --- Encabezados de columnas ---
            const col1X = 15;
            const col2X = 65;
            const col3X = 185;
            
            doc.fontSize(8).font('Helvetica-Bold');
            doc.text('CANT', col1X, doc.y, { width: 40, align: 'center' });
            doc.text('PRODUCTO', col2X, doc.y, { width: 110, align: 'center' });
            doc.text('TOTAL', col3X, doc.y, { width: 70, align: 'center' });
            doc.moveDown(0.3);
            
            drawLine();
            
            // --- Productos ---
            doc.fontSize(8).font('Helvetica');
            let total = 0;
            
            const productosMostrar = datosVenta.productos.slice(0, 10);
            productosMostrar.forEach((item, index) => {
                const subtotal = item.precio * item.cantidad;
                total += subtotal;
                const nombreCorto = item.nombre.length > 18 ? item.nombre.substring(0, 17) + '...' : item.nombre;
                
                // Alternar color para mejor legibilidad (opcional)
                if (index % 2 === 0) {
                    doc.fillColor('#1a1a1a');
                } else {
                    doc.fillColor('#333333');
                }
                
                doc.text(`${item.cantidad}`, col1X, doc.y, { width: 40, align: 'center' });
                doc.text(nombreCorto, col2X, doc.y, { width: 110, align: 'center' });
                doc.text(`S/ ${subtotal.toFixed(2)}`, col3X, doc.y, { width: 70, align: 'center' });
                doc.moveDown(0.25);
            });
            
            if (datosVenta.productos.length > 10) {
                doc.fillColor('#666666');
                doc.fontSize(7).font('Helvetica');
                doc.text(`... y ${datosVenta.productos.length - 10} productos más`, 10, doc.y, {
                    width: pageWidth,
                    align: 'center'
                });
                doc.moveDown(0.3);
            }
            
            drawLine();
            
            // ==========================================
            // 4. TOTALES
            // ==========================================
            const totalConDescuento = datosVenta.totalConDescuento || total;
            const descuento = datosVenta.descuento || 0;
            
            // Subtotal
            doc.fillColor('#1a1a1a');
            doc.fontSize(9).font('Helvetica');
            doc.text('SUBTOTAL:', 120, doc.y, { width: 80, align: 'right' });
            doc.text(`S/ ${total.toFixed(2)}`, 190, doc.y, { width: 60, align: 'right' });
            doc.moveDown(0.2);
            
            // Descuento (si existe)
            if (descuento > 0) {
                doc.fillColor('#cc0000');
                doc.fontSize(9).font('Helvetica');
                doc.text('DESCUENTO:', 120, doc.y, { width: 80, align: 'right' });
                doc.text(`-S/ ${descuento.toFixed(2)}`, 190, doc.y, { width: 60, align: 'right' });
                doc.moveDown(0.2);
            }
            
            // Total (en negrita y más grande)
            doc.fillColor('#1a1a1a');
            doc.fontSize(12).font('Helvetica-Bold');
            doc.text('TOTAL:', 110, doc.y, { width: 90, align: 'right' });
            doc.text(`S/ ${totalConDescuento.toFixed(2)}`, 190, doc.y, { width: 60, align: 'right' });
            doc.moveDown(0.5);
            
            drawLine();
            
            // ==========================================
            // 5. MÉTODO DE PAGO
            // ==========================================
            doc.fillColor('#1a1a1a');
            doc.fontSize(9).font('Helvetica');
            doc.text(`PAGO: ${datosVenta.metodoPago.toUpperCase()}`, 10, doc.y, {
                width: pageWidth,
                align: 'center'
            });
            doc.moveDown(0.3);
            
            drawLine();
            
            // ==========================================
            // 6. MENSAJE FINAL
            // ==========================================
            doc.fillColor('#1a1a1a');
            doc.fontSize(11).font('Helvetica-Bold');
            doc.text('¡GRACIAS POR SU COMPRA!', 10, doc.y, {
                width: pageWidth,
                align: 'center'
            });
            
            doc.fontSize(10).font('Helvetica');
            doc.text('¡VUELVA PRONTO!', 10, doc.y, {
                width: pageWidth,
                align: 'center'
            });
            
            doc.moveDown(0.3);
            doc.fontSize(7).font('Helvetica');
            doc.fillColor('#666666');
            doc.text('📱 Comparta este ticket por WhatsApp', 10, doc.y, {
                width: pageWidth,
                align: 'center'
            });
            
            // ==========================================
            // 7. PIE DE PÁGINA
            // ==========================================
            doc.moveDown(0.5);
            doc.fillColor('#999999');
            doc.fontSize(6).font('Helvetica');
            doc.text('Ticket #' + datosVenta.numero, 10, doc.y, {
                width: pageWidth,
                align: 'center'
            });
            
            doc.end();
        } catch (error) {
            console.error('Error al generar ticket:', error);
            reject(error);
        }
    });
}

function conTimeout(promesa, ms, mensajeError) {
    return Promise.race([
        promesa,
        new Promise((_, reject) => setTimeout(() => reject(new Error(mensajeError)), ms))
    ]);
}

async function enviarTicket(ctx, datosVenta) {
    try {
        const pdfBuffer = await conTimeout(
            generarTicketVenta(datosVenta),
            15000,
            'Tiempo de espera agotado generando el PDF'
        );

        await ctx.replyWithDocument({
            source: pdfBuffer,
            filename: `boleta_${datosVenta.numero}.pdf`
        }, {
            caption: `🧾 **BOLETA #${datosVenta.numero}**\n📱 _Comparte este ticket con tu cliente por WhatsApp_`,
            parse_mode: 'Markdown'
        });

        return { ok: true };
    } catch (error) {
        console.error("❌ Error al enviar boleta:", error);
        return { ok: false, error: error.message || 'Error desconocido' };
    }
}

// ==========================================
// FUNCIÓN: PROCESAR DATOS DEL CLIENTE Y CERRAR LA VENTA
// (reutilizable desde texto libre o desde el botón "Cliente Genérico")
// ==========================================
async function procesarDatosCliente(ctx, estado, texto) {
    if (texto.toLowerCase() === 'cancelar') {
        estado.esperando = null;
        estado.temp = null;
        return ctx.reply("❌ Venta cancelada.");
    }

    const partes = texto.split(/[,;]/).map(p => p.trim());
    const cliente = {
        nombre: partes[0] || '___________________',
        dni: partes[1] || '-',
        ruc: partes[2] || '-',
        telefono: partes[3] || '-'
    };

    if (cliente.nombre === '___________________') {
        return ctx.reply("❌ El nombre del cliente es obligatorio. Usa el formato: `Nombre, DNI, RUC, Teléfono`");
    }

    const metodo = estado.temp?.metodoPago || 'Efectivo';
    const totalVenta = estado.carrito.reduce((acc, item) => acc + (Number(item.precio) * item.cantidad), 0);
    const totalOriginal = estado.carrito.reduce((acc, item) => acc + (Number(item.precioOriginal || item.precio) * item.cantidad), 0);
    const totalCosto = estado.carrito.reduce((acc, item) => acc + (Number(item.costo_unitario || 0) * item.cantidad), 0);
    const totalAhorro = totalOriginal - totalVenta;

    await ctx.reply("⏳ *Procesando venta y generando boleta...*", { parse_mode: 'Markdown' });

    try {
        const itemsArray = estado.carrito.map(item => ({
            id: item.id,
            cantidad: item.cantidad,
            // Number(...) por seguridad: Supabase puede devolver columnas
            // "numeric" como texto, y .toFixed() sobre un string rompía la venta.
            precio: parseFloat(Number(item.precio).toFixed(2)),
            nombre: item.nombre,
            precio_original: item.precioOriginal || item.precio,
            descuento_porcentaje: item.descuentoPorcentaje || 0,
            descuento_fijo: item.descuentoFijo || 0,
            precio_personalizado: item.precioPersonalizado || null,
            precio_sugerido: item.precioSugerido || null
        }));

        const { data: ventaIdRaw, error } = await supabase.rpc('procesar_venta', {
            p_total: parseFloat(totalVenta.toFixed(2)),
            p_metodo_pago: metodo,
            p_rol_vendedor: estado.rol || 'VENDEDOR',
            p_items: itemsArray.map(item => ({
                id: item.id,
                cantidad: item.cantidad,
                precio: item.precio
            }))
        });

        if (error) {
            console.error("❌ Error al procesar venta:", error);
            return ctx.reply(`❌ *Error al procesar la venta:*\n${error.message || 'Error desconocido'}`, { parse_mode: 'Markdown' });
        }

        // La venta ya fue registrada en Supabase en este punto. Normalizamos
        // el id por si la función RPC devuelve un array de filas o un objeto.
        let ventaId = ventaIdRaw;
        if (Array.isArray(ventaId)) ventaId = ventaId[0]?.id ?? ventaId[0] ?? ventaId;
        if (ventaId && typeof ventaId === 'object') ventaId = ventaId.id ?? JSON.stringify(ventaId);

        const datosTicket = {
            numero: ventaId,
            cliente: cliente.nombre,
            dni: cliente.dni,
            ruc: cliente.ruc,
            telefono: cliente.telefono,
            productos: estado.carrito.map(item => ({
                nombre: item.nombre,
                cantidad: item.cantidad,
                precio: Number(item.precio)
            })),
            total: totalOriginal,
            totalConDescuento: totalVenta,
            descuento: totalAhorro,
            metodoPago: metodo,
            vendedor: estado.rol || 'VENDEDOR'
        };

        const resultadoTicket = await enviarTicket(ctx, datosTicket);

        let msg = `✅ **¡VENTA #${ventaId} REGISTRADA!**\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `👤 *Cliente:* ${cliente.nombre}\n`;
        if (cliente.dni !== '-') msg += `🪪 *DNI:* ${cliente.dni}\n`;
        if (cliente.ruc !== '-') msg += `📋 *RUC:* ${cliente.ruc}\n`;
        if (cliente.telefono !== '-') msg += `📱 *Tel:* ${cliente.telefono}\n`;
        msg += `💳 *Pago:* ${metodo}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        estado.carrito.forEach(item => {
            const subtotal = Number(item.precio) * item.cantidad;
            msg += `• ${item.nombre} x${item.cantidad} — ${fmt(subtotal)}\n`;
        });

        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `💰 *Total:* ${fmt(totalVenta)}\n`;
        if (totalAhorro > 0) {
            msg += `💵 *Ahorro:* ${fmt(totalAhorro)}\n`;
        }
        msg += `📈 *Utilidad:* ${fmt(totalVenta - totalCosto)}\n`;

        if (!resultadoTicket.ok) {
            msg += `\n⚠️ *La venta se guardó correctamente, pero no se pudo generar/enviar el PDF de la boleta.*\n`;
            msg += `_Motivo: ${resultadoTicket.error}_\n`;
            msg += `\nPuedes reintentar el envío con el botón de abajo.`;
        }

        limpiarCarrito(estado); // Nota: esto también resetea estado.temp

        const keyboard = { inline_keyboard: [] };
        if (!resultadoTicket.ok) {
            // Re-guardamos la boleta pendiente después de limpiar el carrito,
            // porque limpiarCarrito() borra estado.temp.
            estado.temp = { ultimaBoleta: datosTicket };
            keyboard.inline_keyboard.push([{ text: "🔄 Reintentar enviar boleta", callback_data: "reintentar_boleta" }]);
        }
        keyboard.inline_keyboard.push([
            { text: "🆕 Nueva Venta", callback_data: "buscar_productos" },
            { text: "🏠 Menú Principal", callback_data: "menu_principal" }
        ]);

        await ctx.reply(msg, { reply_markup: keyboard, parse_mode: 'Markdown' });
        return;

    } catch (error) {
        console.error("❌ Error en venta:", error);
        return ctx.reply(`❌ *Error al procesar la venta:*\n${error.message || 'Error desconocido'}`, { parse_mode: 'Markdown' });
    }
}

// ==========================================
// 11. FUNCIONES DE REPORTES (CON PAGINACIÓN)
// ==========================================
async function mostrarReporteMovimientos(ctx, pagina = 1) {
    try {
        const ITEMS_POR_PAGINA = 5;
        
        const { count: totalMovimientos, error: countError } = await supabase
            .from('movimientos_inventario')
            .select('*', { count: 'exact', head: true });

        if (countError) {
            console.error("Error al contar movimientos:", countError);
            return ctx.reply("❌ Error al generar el reporte.");
        }

        if (totalMovimientos === 0) {
            return ctx.reply(
                "📊 **REPORTE DE MOVIMIENTOS**\n\n" +
                "No hay movimientos registrados aún.\n\n" +
                "Los movimientos se registran automáticamente cuando:\n" +
                "• Se vende un producto (SALIDA)\n" +
                "• Se registra una compra (ENTRADA)\n" +
                "• Se edita el stock de un producto (AJUSTE)",
                { parse_mode: 'Markdown' }
            );
        }

        const totalPaginas = Math.ceil(totalMovimientos / ITEMS_POR_PAGINA);
        const offset = (pagina - 1) * ITEMS_POR_PAGINA;

        const { data: movimientos, error } = await supabase
            .from('movimientos_inventario')
            .select(`
                *,
                productos (
                    nombre,
                    marca
                )
            `)
            .order('created_at', { ascending: false })
            .range(offset, offset + ITEMS_POR_PAGINA - 1);

        if (error) {
            console.error("Error en reporte de movimientos:", error);
            return ctx.reply("❌ Error al generar el reporte.");
        }

        let mensaje = `📊 **REPORTE DE MOVIMIENTOS**\n`;
        mensaje += `📅 _Página ${pagina} de ${totalPaginas}_\n`;
        mensaje += `📦 Total: ${totalMovimientos} movimientos\n`;
        mensaje += `-----------------------------------\n\n`;

        movimientos.forEach(m => {
            const tipoIcono = m.tipo_movimiento === 'ENTRADA' ? '📥' : 
                             m.tipo_movimiento === 'SALIDA' ? '📤' : '📝';
            const signo = m.tipo_movimiento === 'ENTRADA' ? '+' : 
                         m.tipo_movimiento === 'SALIDA' ? '-' : '±';
            const nombreProducto = m.productos?.nombre || 'Producto eliminado';
            
            mensaje += `${tipoIcono} *${m.tipo_movimiento}*\n`;
            mensaje += `📦 ${nombreProducto}\n`;
            mensaje += `🔢 ${signo}${m.cantidad}\n`;
            mensaje += `📊 ${m.stock_anterior} → ${m.stock_nuevo}\n`;
            mensaje += `👤 ${m.usuario || 'Sistema'}\n`;
            mensaje += `🕐 ${new Date(m.created_at).toLocaleString()}\n`;
            mensaje += `-----------------------------------\n`;
        });

        const keyboard = {
            inline_keyboard: []
        };

        if (pagina > 1) {
            keyboard.inline_keyboard.push([
                { text: "◀️ Anterior", callback_data: `movimientos_pagina_${pagina-1}` }
            ]);
        }

        if (pagina < totalPaginas) {
            keyboard.inline_keyboard.push([
                { text: "Siguiente ▶️", callback_data: `movimientos_pagina_${pagina+1}` }
            ]);
        }

        keyboard.inline_keyboard.push([
            { text: "📈 Resumen", callback_data: "resumen_inventario" },
            { text: "🏠 Menú", callback_data: "menu_principal" }
        ]);

        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error en mostrarReporteMovimientos:", error);
        return ctx.reply("❌ Error al generar el reporte.");
    }
}

async function mostrarResumenInventario(ctx) {
    ctx.reply("📈 Generando resumen de inventario...");
    
    try {
        const { data: stats, error: statsError } = await supabase
            .from('productos')
            .select('*');

        if (statsError) {
            console.error("Error en resumen:", statsError);
            return ctx.reply("❌ Error al generar el resumen.");
        }

        const { data: criticos, error: criticosError } = await supabase
            .from('productos')
            .select('*')
            .lt('stock', 5)
            .order('stock', { ascending: true });

        const inicioHoy = new Date(); 
        inicioHoy.setHours(0,0,0,0);
        const finHoy = new Date(); 
        finHoy.setHours(23,59,59,999);

        const { data: movimientosHoy, error: movError } = await supabase
            .from('movimientos_inventario')
            .select('tipo_movimiento, cantidad')
            .gte('created_at', inicioHoy.toISOString())
            .lte('created_at', finHoy.toISOString());

        let totalProductos = stats?.length || 0;
        let totalStock = 0;
        let valorInventario = 0;
        let valorVenta = 0;

        if (stats) {
            stats.forEach(p => {
                totalStock += p.stock || 0;
                valorInventario += (p.precio_costo || 0) * (p.stock || 0);
                valorVenta += (p.precio_venta || 0) * (p.stock || 0);
            });
        }

        let entradasHoy = 0;
        let salidasHoy = 0;
        if (movimientosHoy) {
            movimientosHoy.forEach(m => {
                if (m.tipo_movimiento === 'ENTRADA') entradasHoy += m.cantidad;
                else if (m.tipo_movimiento === 'SALIDA') salidasHoy += m.cantidad;
            });
        }

        let mensaje = "📈 **RESUMEN DE INVENTARIO**\n";
        mensaje += `📅 _${new Date().toLocaleDateString()}_\n`;
        mensaje += `-----------------------------------\n\n`;
        mensaje += `📦 **Totales Generales:**\n`;
        mensaje += `• Productos únicos: ${totalProductos}\n`;
        mensaje += `• Unidades en stock: ${totalStock}\n`;
        mensaje += `💰 Valor de inventario: ${fmt(valorInventario)}\n`;
        mensaje += `💵 Valor de venta: ${fmt(valorVenta)}\n\n`;
        
        mensaje += `📊 **Movimientos de Hoy:**\n`;
        mensaje += `• 📥 Entradas: ${entradasHoy} unidades\n`;
        mensaje += `• 📤 Salidas: ${salidasHoy} unidades\n\n`;

        if (criticos && criticos.length > 0) {
            mensaje += `⚠️ **Productos con stock bajo (< 5):**\n`;
            criticos.slice(0, 10).forEach(p => {
                mensaje += `• ${p.nombre}: ${p.stock} unidades\n`;
            });
            if (criticos.length > 10) {
                mensaje += `... y ${criticos.length - 10} más\n`;
            }
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: "📊 Ver Movimientos", callback_data: "reporte_movimientos" }],
                [{ text: "📥 Registrar Compra", callback_data: "registrar_compra" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };

        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error:", error);
        return ctx.reply("❌ Error al generar el resumen.");
    }
}

async function mostrarMovimientosProducto(ctx, productoNombre) {
    try {
        const { data: productos, error: searchError } = await supabase
            .from('productos')
            .select('id, nombre, marca')
            .ilike('nombre', `%${productoNombre}%`)
            .limit(1);

        if (searchError || !productos || productos.length === 0) {
            return ctx.reply("❌ Producto no encontrado.");
        }

        const producto = productos[0];

        const { data: movimientos, error: movError } = await supabase
            .from('movimientos_inventario')
            .select('*')
            .eq('producto_id', producto.id)
            .order('created_at', { ascending: false })
            .limit(30);

        if (movError) {
            console.error("Error:", movError);
            return ctx.reply("❌ Error al obtener los movimientos.");
        }

        let mensaje = `📊 **MOVIMIENTOS DE PRODUCTO**\n`;
        mensaje += `📦 *${producto.nombre}* (${producto.marca})\n`;
        mensaje += `-----------------------------------\n\n`;

        if (!movimientos || movimientos.length === 0) {
            mensaje += "Este producto no tiene movimientos registrados.";
        } else {
            movimientos.forEach(m => {
                const tipoIcono = m.tipo_movimiento === 'ENTRADA' ? '📥' : '📤';
                const signo = m.tipo_movimiento === 'ENTRADA' ? '+' : '-';
                mensaje += `${tipoIcono} *${m.tipo_movimiento}*\n`;
                mensaje += `Cantidad: ${signo}${m.cantidad}\n`;
                mensaje += `Stock: ${m.stock_anterior} → ${m.stock_nuevo}\n`;
                mensaje += `Motivo: ${m.motivo || 'N/A'}\n`;
                mensaje += `🕐 ${new Date(m.created_at).toLocaleString()}\n`;
                mensaje += `-----------------------------------\n`;
            });
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: "🔍 Buscar otro", callback_data: "movimientos_producto" }],
                [{ text: "📊 Resumen General", callback_data: "resumen_inventario" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };

        const estado = getEstado(ctx.from.id);
        estado.esperando = null;

        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error:", error);
        return ctx.reply("❌ Error al obtener los movimientos.");
    }
}

// ==========================================
// COMANDOS
// ==========================================

bot.command('start', (ctx) => {
    const estado = getEstado(ctx.from.id);
    
    if (estado.autenticado) {
        limpiarCarrito(estado);
        return mostrarMenuPrincipal(ctx);
    }
    
    estado.esperando = 'pin';
    estado.carrito = [];
    estado.resultadosBusqueda = null;
    estado.autenticado = false;
    estado.rol = null;
    estado.temp = null;
    estado.paginaActual = 1;
    
    mostrarMenuPrincipal(ctx);
});

bot.command('menu', (ctx) => {
    const estado = getEstado(ctx.from.id);
    
    if (!estado.autenticado) {
        return ctx.reply("⚠️ Por favor ejecuta /start para ingresar al sistema.");
    }
    
    limpiarCarrito(estado);
    mostrarMenuPrincipal(ctx);
});

// ==========================================
// 🧠 PROCESAMIENTO CENTRAL DE TEXTO
// ==========================================
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const texto = ctx.message.text.trim();
    const estado = getEstado(userId);

    // CONTROL DE PIN
    if (estado.esperando === 'pin') {
        if (texto === '0316') {
            estado.autenticado = true;
            estado.rol = 'ADMINISTRADOR';
            estado.esperando = null;
            await ctx.reply("👑 **Modo ADMINISTRADOR iniciado.**");
            return mostrarMenuPrincipal(ctx);
        } else if (texto === '1234') {
            estado.autenticado = true;
            estado.rol = 'VENDEDOR';
            estado.esperando = null;
            await ctx.reply("👷‍♂️ **Modo VENDEDOR iniciado.**");
            return mostrarMenuPrincipal(ctx);
        } else {
            return ctx.reply("❌ Acceso denegado. PIN incorrecto.");
        }
    }

    if (!estado.autenticado) return ctx.reply("⚠️ Por favor ejecuta /start para ingresar al sistema.");

    // ==========================================
    // FLUJO: DATOS DEL CLIENTE Y PROCESAR VENTA
    // ==========================================
    if (estado.esperando === 'datos_cliente') {
        return procesarDatosCliente(ctx, estado, texto);
    }

    // ==========================================
    // FLUJO: EDITAR PRECIO DE ITEM EN CARRITO
    // ==========================================
    if (estado.esperando === 'editar_precio_item') {
        if (texto.toLowerCase() === 'cancelar') {
            estado.esperando = null;
            estado.temp = null;
            return mostrarCarrito(ctx, estado);
        }
        
        const partes = texto.split(/[,;]/).map(p => p.trim());
        if (partes.length < 2) {
            return ctx.reply("❌ Formato incorrecto. Usa: `número, precio`");
        }
        
        const num = parseInt(partes[0]) - 1;
        const nuevoPrecio = parseFloat(partes[1].replace(',', '.'));
        
        if (isNaN(num) || num < 0 || num >= estado.carrito.length) {
            return ctx.reply("❌ Número de producto inválido.");
        }
        
        if (isNaN(nuevoPrecio) || nuevoPrecio <= 0) {
            return ctx.reply("❌ Precio inválido. Debe ser mayor a 0.");
        }
        
        const item = estado.carrito[num];
        const precioAnterior = item.precio;
        item.precio = formatearNumero(nuevoPrecio);
        item.precioPersonalizado = nuevoPrecio;
        item.precioOriginal = item.precioOriginal || precioAnterior;
        
        estado.esperando = null;
        estado.temp = null;
        
        const total = estado.carrito.reduce((acc, i) => acc + (i.precio * i.cantidad), 0);
        
        let mensaje = `✅ **Precio actualizado:**\n`;
        mensaje += `📦 ${item.nombre}\n`;
        mensaje += `💰 Precio anterior: ${fmt(precioAnterior)}\n`;
        mensaje += `💵 Nuevo precio: ${fmt(item.precio)}\n`;
        mensaje += `📊 Nuevo subtotal: ${fmt(item.precio * item.cantidad)}\n`;
        mensaje += `🛒 Total carrito: ${fmt(total)}`;
        
        await ctx.reply(mensaje, { parse_mode: 'Markdown' });
        return mostrarCarrito(ctx, estado);
    }

    // ==========================================
    // FLUJO: DESCUENTO GLOBAL AL CARRITO
    // ==========================================
    if (estado.esperando === 'descuento_global') {
        if (texto.toLowerCase() === 'cancelar') {
            estado.esperando = null;
            estado.temp = null;
            return mostrarCarrito(ctx, estado);
        }
        
        const partes = texto.split(/[,;]/).map(p => p.trim());
        if (partes.length < 2) {
            return ctx.reply("❌ Formato incorrecto. Usa: `tipo, valor`\nEjemplos:\n`porcentaje, 10` (10% de descuento)\n`fijo, 5` (S/.5 de descuento)");
        }
        
        const tipo = partes[0].toLowerCase();
        const valor = parseFloat(partes[1].replace(',', '.'));
        
        if (isNaN(valor) || valor <= 0) {
            return ctx.reply("❌ Valor inválido. Debe ser mayor a 0.");
        }
        
        if (tipo !== 'porcentaje' && tipo !== 'fijo' && tipo !== '%' && tipo !== 's/') {
            return ctx.reply("❌ Tipo inválido. Usa: `porcentaje` o `fijo`");
        }
        
        let totalAhorro = 0;
        let mensaje = "✅ **Descuento global aplicado:**\n\n";
        
        if (tipo === 'porcentaje' || tipo === '%') {
            const porcentaje = valor;
            if (porcentaje < 0 || porcentaje > 100) {
                return ctx.reply("❌ El porcentaje debe ser entre 0 y 100.");
            }
            
            estado.carrito.forEach(item => {
                const descuento = item.precio * (porcentaje / 100);
                item.precio = formatearNumero(item.precio - descuento);
                item.descuentoPorcentaje = (item.descuentoPorcentaje || 0) + porcentaje;
                totalAhorro += descuento * item.cantidad;
            });
            
            mensaje += `📊 Descuento del ${porcentaje}% aplicado a todos los productos\n`;
        } else if (tipo === 'fijo' || tipo === 's/') {
            const descuentoFijo = valor;
            const totalItems = estado.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
            
            estado.carrito.forEach(item => {
                const subtotal = item.precio * item.cantidad;
                const proporcion = subtotal / totalItems;
                const descuentoItem = descuentoFijo * proporcion;
                const descuentoUnitario = descuentoItem / item.cantidad;
                
                item.precio = formatearNumero(item.precio - descuentoUnitario);
                item.descuentoFijo = (item.descuentoFijo || 0) + descuentoFijo * proporcion;
                totalAhorro += descuentoItem;
            });
            
            mensaje += `💰 Descuento fijo de S/. ${descuentoFijo.toFixed(2)} aplicado al total\n`;
        }
        
        const nuevoTotal = estado.carrito.reduce((acc, item) => acc + (item.precio * item.cantidad), 0);
        mensaje += `💵 Total ahorro: ${fmt(totalAhorro)}\n`;
        mensaje += `🛒 Nuevo total: ${fmt(nuevoTotal)}`;
        
        estado.esperando = null;
        estado.temp = null;
        
        await ctx.reply(mensaje, { parse_mode: 'Markdown' });
        return mostrarCarrito(ctx, estado);
    }

    // ==========================================
    // FLUJO: BUSCAR PRODUCTOS
    // ==========================================
    if (estado.esperando === 'busqueda') {
        ctx.reply("⏳ Buscando...");
        try {
            const { data: productos, error } = await supabase.rpc('buscar_productos_ferreteria', { 
                termino_busqueda: texto 
            });
            
            if (error) {
                console.error("Error en búsqueda:", error);
                return ctx.reply("❌ Error al buscar productos.");
            }
            
            if (!productos || productos.length === 0) {
                return ctx.reply("❌ No se encontraron coincidencias.");
            }

            estado.resultadosBusqueda = productos;
            estado.esperando = 'numero';
            estado.paginaActual = 1;

            return mostrarPaginaProductos(ctx, productos, 1, true);
        } catch (error) {
            console.error("Error en búsqueda:", error);
            return ctx.reply("❌ Error al buscar productos.");
        }
    }

    // ==========================================
    // FLUJO: AGREGAR AL CARRITO CON TODAS LAS OPCIONES
    // ==========================================
    if (estado.esperando === 'numero') {
        const textoLimpio = texto.replace(/\s+/g, ' ').trim();
        const partes = textoLimpio.split(/[,;]/).map(p => p.trim());
        
        const primerNumero = partes[0].match(/\d+/);
        if (!primerNumero) {
            return ctx.reply("❌ Selección inválida. Envía el número de producto.");
        }
        
        const opcion = parseInt(primerNumero[0]) - 1;
        let cantidadAAgregar = 1;
        let descuentoPorcentaje = 0;
        let descuentoFijo = 0;
        let precioPersonalizado = null;
        let usarPrecioSugerido = false;
        
        let numerosEncontrados = [];
        
        for (let i = 0; i < partes.length; i++) {
            const parte = partes[i].toLowerCase().trim();
            
            const esNumeroPuro = /^\d+$/.test(parte) || /^\d+\.\d+$/.test(parte);
            
            if (esNumeroPuro && !parte.includes('precio') && !parte.includes('desc') && !parte.includes('sugerido')) {
                const num = parseFloat(parte);
                if (num > 0) {
                    if (numerosEncontrados.length === 0) {
                        numerosEncontrados.push(num);
                    } else if (numerosEncontrados.length === 1 && cantidadAAgregar === 1) {
                        cantidadAAgregar = parseInt(num);
                        numerosEncontrados.push(num);
                    }
                }
            }
            
            if (parte.includes('precio')) {
                const precioMatch = parte.match(/\d+\.?\d*/);
                if (precioMatch) {
                    precioPersonalizado = parseFloat(precioMatch[0]);
                    if (precioPersonalizado <= 0) {
                        return ctx.reply("❌ El precio debe ser mayor a 0.");
                    }
                }
            }
            
            if (parte.includes('sugerido') || parte.includes('sug')) {
                usarPrecioSugerido = true;
            }
            
            if ((parte.includes('desc') || parte.includes('%')) && !parte.includes('global')) {
                const descMatch = parte.match(/\d+/);
                if (descMatch) {
                    descuentoPorcentaje = parseFloat(descMatch[0]);
                    if (descuentoPorcentaje < 0 || descuentoPorcentaje > 100) {
                        return ctx.reply("❌ El descuento porcentual debe ser entre 0 y 100%.");
                    }
                }
            }
            
            if ((parte.includes('s/') || parte.includes('$') || parte.includes('descuento')) && 
                !parte.includes('%') && !parte.includes('global') && !parte.includes('precio')) {
                const descMatch = parte.match(/\d+\.?\d*/);
                if (descMatch) {
                    descuentoFijo = parseFloat(descMatch[0]);
                    if (descuentoFijo < 0) {
                        return ctx.reply("❌ El descuento fijo debe ser mayor a 0.");
                    }
                }
            }
        }
        
        if (cantidadAAgregar === 1) {
            const todosNumeros = texto.match(/\d+/g);
            if (todosNumeros && todosNumeros.length >= 2) {
                cantidadAAgregar = parseInt(todosNumeros[1]);
            }
        }
        
        if (isNaN(cantidadAAgregar) || cantidadAAgregar < 1) {
            cantidadAAgregar = 1;
        }
        
        const productos = estado.resultadosBusqueda;
        if (!productos || opcion < 0 || opcion >= productos.length) {
            return ctx.reply("❌ Opción inválida de la lista.");
        }

        const prodElegido = productos[opcion];
        
        if (cantidadAAgregar > prodElegido.stock) {
            return ctx.reply(`⚠️ Stock insuficiente. Solo quedan ${prodElegido.stock} unidades.`);
        }

        let precioFinal = prodElegido.precio_venta;
        let precioSugerido = null;
        
        if (usarPrecioSugerido) {
            precioSugerido = calcularPrecioSugerido(
                prodElegido.precio_venta,
                cantidadAAgregar,
                prodElegido.precio_costo || 0
            );
            precioFinal = precioSugerido;
        }
        
        if (precioPersonalizado !== null) {
            precioFinal = precioPersonalizado;
        }
        
        let descuentoUnitario = 0;
        let descuentoTotal = 0;
        
        if (descuentoPorcentaje > 0) {
            descuentoUnitario = precioFinal * (descuentoPorcentaje / 100);
        }
        
        if (descuentoFijo > 0) {
            descuentoUnitario += (descuentoFijo / cantidadAAgregar);
        }
        
        precioFinal = precioFinal - descuentoUnitario;
        precioFinal = formatearNumero(precioFinal);
        
        descuentoTotal = (descuentoPorcentaje > 0 ? (precioPersonalizado || prodElegido.precio_venta) * (descuentoPorcentaje / 100) : 0) + (descuentoFijo > 0 ? descuentoFijo : 0);
        descuentoTotal = formatearNumero(descuentoTotal);

        const itemExistente = estado.carrito.find(item => item.id === prodElegido.id);
        const cantidadTotal = (itemExistente ? itemExistente.cantidad : 0) + cantidadAAgregar;

        if (itemExistente) {
            if (cantidadTotal > prodElegido.stock) {
                return ctx.reply(`⚠️ Stock insuficiente. Solo quedan ${prodElegido.stock} unidades.`);
            }
            itemExistente.cantidad = cantidadTotal;
            itemExistente.precio = precioFinal;
            itemExistente.descuentoPorcentaje = (itemExistente.descuentoPorcentaje || 0) + descuentoPorcentaje;
            itemExistente.descuentoFijo = (itemExistente.descuentoFijo || 0) + descuentoFijo;
            if (precioPersonalizado !== null) {
                itemExistente.precioPersonalizado = precioPersonalizado;
            }
            if (precioSugerido !== null) {
                itemExistente.precioSugerido = precioSugerido;
            }
            itemExistente.descuentoTotal = (itemExistente.descuentoTotal || 0) + descuentoTotal;
        } else {
            const nuevoItem = {
                id: prodElegido.id,
                nombre: prodElegido.nombre,
                marca: prodElegido.marca,
                precio: precioFinal,
                cantidad: cantidadAAgregar,
                precioOriginal: prodElegido.precio_venta,
                costo_unitario: prodElegido.precio_costo || 0,
                descuentoPorcentaje: descuentoPorcentaje || 0,
                descuentoFijo: descuentoFijo || 0,
                descuentoTotal: descuentoTotal || 0,
                precioPersonalizado: precioPersonalizado || null,
                precioSugerido: precioSugerido || null
            };
            estado.carrito.push(nuevoItem);
        }

        estado.esperando = null;
        
        let mensaje = `✅ **${prodElegido.nombre}** x${cantidadAAgregar} agregado al carrito`;
        
        if (precioSugerido !== null) {
            mensaje += `\n📊 Precio sugerido: ${fmt(precioSugerido)}`;
            mensaje += `\n📊 Original: ${fmt(prodElegido.precio_venta)}`;
        }
        if (precioPersonalizado !== null) {
            mensaje += `\n💰 Precio personalizado: ${fmt(precioPersonalizado)}`;
            mensaje += `\n📊 Original: ${fmt(prodElegido.precio_venta)}`;
        }
        if (descuentoPorcentaje > 0) {
            mensaje += `\n💰 Descuento: ${descuentoPorcentaje}%`;
        }
        if (descuentoFijo > 0) {
            mensaje += `\n💰 Descuento fijo: S/. ${descuentoFijo.toFixed(2)}`;
        }
        if (descuentoTotal > 0) {
            mensaje += `\n💵 Ahorro total: ${fmt(descuentoTotal)}`;
        }
        mensaje += `\n💵 Precio final: ${fmt(precioFinal)}`;
        mensaje += `\n📦 Stock restante: ${prodElegido.stock - cantidadAAgregar}`;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: "🔍 Seguir agregando", callback_data: "seguir_agregando" }],
                [{ text: "🛒 Ver carrito", callback_data: "ver_carrito" }],
                [{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]
            ]
        };
        
        return ctx.reply(mensaje, { reply_markup: keyboard, parse_mode: 'Markdown' });
    }

    // ==========================================
    // 👑 FLUJO ADMIN: REGISTRAR PRODUCTO NUEVO
    // ==========================================
    if (estado.esperando?.startsWith('agregar_')) {
        if (estado.esperando === 'agregar_nombre') {
            if (texto.length < 2) return ctx.reply("❌ El nombre debe tener al menos 2 caracteres.");
            estado.temp.nombre = texto;
            estado.esperando = 'agregar_marca';
            return ctx.reply("📦 Escribe la MARCA del producto:");
        }
        
        if (estado.esperando === 'agregar_marca') {
            if (texto.length < 1) return ctx.reply("❌ La marca es obligatoria.");
            estado.temp.marca = texto;
            estado.esperando = 'agregar_seccion';
            return ctx.reply(
                "📍 **SECCIÓN / UBICACIÓN**\n\n" +
                "Formato: Letra + Número\n" +
                "• `A1` (Pasillo A, Estante 1)\n" +
                "• `B3` (Pasillo B, Estante 3)\n" +
                "• `C2` (Pasillo C, Estante 2)",
                { parse_mode: 'Markdown' }
            );
        }
        
        if (estado.esperando === 'agregar_seccion') {
            const seccionValida = /^[A-Z]\d+$/i.test(texto.toUpperCase());
            if (!seccionValida) {
                return ctx.reply("❌ Formato inválido. Usa: `A1`, `B3`, `C12`");
            }
            estado.temp.seccion = texto.toUpperCase();
            estado.esperando = 'agregar_costo';
            return ctx.reply("💰 Escribe el PRECIO DE COSTO:\nEjemplo: `15.50` o `20`");
        }
        
        if (estado.esperando === 'agregar_costo') {
            const val = parseFloat(texto.replace(',', '.'));
            if (isNaN(val) || val <= 0) {
                return ctx.reply("❌ Número inválido. Ingresa un precio mayor a 0:");
            }
            estado.temp.precio_costo = formatearNumero(val);
            estado.esperando = 'agregar_precio';
            return ctx.reply("💵 Escribe el PRECIO DE VENTA:\nEjemplo: `25.90` o `30`");
        }
        
        if (estado.esperando === 'agregar_precio') {
            const val = parseFloat(texto.replace(',', '.'));
            if (isNaN(val) || val <= 0) {
                return ctx.reply("❌ Número inválido. Ingresa un precio mayor a 0:");
            }
            if (val <= estado.temp.precio_costo) {
                return ctx.reply(`⚠️ El precio de venta (${fmt(val)}) debe ser mayor al costo (${fmt(estado.temp.precio_costo)}).`);
            }
            estado.temp.precio_venta = formatearNumero(val);
            estado.esperando = 'agregar_stock';
            return ctx.reply("🔢 Escribe el STOCK INICIAL:\nEjemplo: `100`");
        }
        
        if (estado.esperando === 'agregar_stock') {
            const val = parseInt(texto);
            if (isNaN(val) || val < 0) return ctx.reply("❌ Cantidad inválida. Ingresa un número válido:");
            estado.temp.stock = val;

            ctx.reply("⏳ Guardando en la base de datos...");
            const { error } = await supabase.from('productos').insert([estado.temp]);

            if (error) {
                console.error("🔴 Error Supabase:", error);
                return ctx.reply("❌ Error al guardar. Verifica que no exista un producto con el mismo nombre.");
            }

            await ctx.reply(
                `✅ **¡Producto Creado!**\n\n` +
                `📦 *${estado.temp.nombre}*\n` +
                `🏭 ${estado.temp.marca}\n` +
                `📍 ${estado.temp.seccion}\n` +
                `💰 Costo: ${fmt(estado.temp.precio_costo)} | 💲 Venta: ${fmt(estado.temp.precio_venta)}\n` +
                `📦 Stock: ${val}`,
                { parse_mode: 'Markdown' }
            );
            estado.esperando = null;
            estado.temp = null;
            return mostrarMenuPrincipal(ctx);
        }
    }

    // ==========================================
    // 👑 FLUJO ADMIN: EDITAR PRODUCTO
    // ==========================================
    if (estado.esperando === 'editar_buscar') {
        try {
            const { data: productos, error } = await supabase.rpc('buscar_productos_ferreteria', { 
                termino_busqueda: texto 
            });
            
            if (error) {
                console.error("Error en búsqueda para editar:", error);
                return ctx.reply("❌ Error al buscar productos.");
            }
            
            if (!productos || productos.length === 0) {
                return ctx.reply("❌ No se encontró el producto.");
            }

            estado.resultadosBusqueda = productos;
            estado.esperando = 'editar_seleccion';

            let r = "📝 **Selecciona producto:**\n\n";
            productos.forEach((p, idx) => {
                r += mostrarProducto(p, idx);
            });
            r += "\n🔢 Número del producto:";
            return ctx.reply(r, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error("Error:", error);
            return ctx.reply("❌ Error al buscar productos.");
        }
    }

    if (estado.esperando === 'editar_seleccion') {
        const num = parseInt(texto) - 1;
        const productos = estado.resultadosBusqueda;
        
        if (!productos || num < 0 || num >= productos.length) {
            return ctx.reply("❌ Selección inválida.");
        }

        estado.temp = productos[num];
        estado.esperando = 'editar_ejecutar';

        let m = `🛠️ **${estado.temp.nombre}**\n`;
        m += mostrarProducto(estado.temp);
        m += `\n**Modificar:**\n`;
        m += `• \`stock 150\`\n`;
        m += `• \`costo 12.50\`\n`;
        m += `• \`precio 25.90\`\n`;
        m += `• \`seccion B3\`\n`;
        m += `• \`todos 100 15.50 25.90 B3\``;
        return ctx.reply(m, { parse_mode: 'Markdown' });
    }

    if (estado.esperando === 'editar_ejecutar') {
        const partes = texto.split(/\s+/);
        if (partes.length < 2) {
            return ctx.reply("❌ Formato: `campo valor`");
        }

        const campo = partes[0].toLowerCase();
        const updateObj = {};
        let mensajeConfirmacion = '';

        if (campo === 'todos' && partes.length >= 4) {
            const stock = parseInt(partes[1]);
            const costo = parseFloat(partes[2].replace(',', '.'));
            const precio = parseFloat(partes[3].replace(',', '.'));
            const seccion = partes[4] ? partes[4].toUpperCase() : estado.temp.seccion || '📦';
            
            if (isNaN(stock) || stock < 0) return ctx.reply("❌ Stock inválido.");
            if (isNaN(costo) || costo <= 0) return ctx.reply("❌ Costo inválido.");
            if (isNaN(precio) || precio <= 0) return ctx.reply("❌ Precio inválido.");
            if (precio <= costo) return ctx.reply(`⚠️ Precio debe ser mayor al costo.`);
            
            const seccionValida = /^[A-Z]\d+$/i.test(seccion);
            if (!seccionValida && seccion !== '📦') {
                return ctx.reply("❌ Sección inválida. Usa: `A1`, `B3`, `C12`");
            }
            
            updateObj.stock = stock;
            updateObj.precio_costo = formatearNumero(costo);
            updateObj.precio_venta = formatearNumero(precio);
            if (seccion !== '📦') {
                updateObj.seccion = seccion;
            }
            
            mensajeConfirmacion = 
                `📦 Stock: **${stock}**\n` +
                `💰 Costo: ${fmt(costo)}\n` +
                `💵 Venta: ${fmt(precio)}\n` +
                `📍 Sección: ${seccion}`;
        } else {
            const valorInput = partes.slice(1).join(' ');
            
            if (campo === 'stock') {
                const val = parseInt(valorInput);
                if (isNaN(val) || val < 0) return ctx.reply("❌ Stock inválido.");
                updateObj.stock = val;
                mensajeConfirmacion = `📦 Stock: **${val}**`;
            } else if (campo === 'costo') {
                const val = parseFloat(valorInput.replace(',', '.'));
                if (isNaN(val) || val <= 0) return ctx.reply("❌ Costo inválido.");
                updateObj.precio_costo = formatearNumero(val);
                mensajeConfirmacion = `💰 Costo: ${fmt(val)}`;
            } else if (campo === 'precio') {
                const val = parseFloat(valorInput.replace(',', '.'));
                if (isNaN(val) || val <= 0) return ctx.reply("❌ Precio inválido.");
                updateObj.precio_venta = formatearNumero(val);
                mensajeConfirmacion = `💵 Precio: ${fmt(val)}`;
            } else if (campo === 'seccion') {
                const seccionValida = /^[A-Z]\d+$/i.test(valorInput.toUpperCase());
                if (!seccionValida) {
                    return ctx.reply("❌ Sección inválida. Usa: `A1`, `B3`, `C12`");
                }
                updateObj.seccion = valorInput.toUpperCase();
                mensajeConfirmacion = `📍 Sección: **${valorInput.toUpperCase()}**`;
            } else {
                return ctx.reply("❌ Usa: `stock`, `costo`, `precio`, `seccion` o `todos`.");
            }
        }

        ctx.reply("⏳ Actualizando...");

        try {
            const { error } = await supabase
                .from('productos')
                .update(updateObj)
                .eq('id', estado.temp.id);

            if (error) {
                console.error("🔴 Error:", error);
                return ctx.reply("❌ Error al actualizar.");
            }

            const { data: productoActualizado } = await supabase
                .from('productos')
                .select('*')
                .eq('id', estado.temp.id)
                .single();

            await ctx.reply(
                `✅ **¡Actualizado!**\n\n` +
                `📦 *${estado.temp.nombre}*\n` +
                `${mensajeConfirmacion}\n\n` +
                `📊 **Estado actual:**\n` +
                `💰 Costo: ${fmt(productoActualizado?.precio_costo || estado.temp.precio_costo)}\n` +
                `💵 Venta: ${fmt(productoActualizado?.precio_venta || estado.temp.precio_venta)}\n` +
                `📦 Stock: ${productoActualizado?.stock || estado.temp.stock}\n` +
                `📍 Sección: ${productoActualizado?.seccion || estado.temp.seccion || '📦'}`,
                { parse_mode: 'Markdown' }
            );

            estado.esperando = null;
            estado.temp = null;
            estado.resultadosBusqueda = null;
            return mostrarMenuPrincipal(ctx);
        } catch (error) {
            console.error("Error:", error);
            return ctx.reply("❌ Error al actualizar.");
        }
    }

    // ==========================================
    // FLUJO ADMIN: REGISTRAR COMPRA
    // ==========================================
    if (estado.esperando === 'compra_buscar') {
        estado.temp = { proveedor: texto, items: [] };
        estado.esperando = 'compra_productos';
        return ctx.reply(
            "📦 **Registrar Compra**\n\n" +
            "Busca productos:\n" +
            "Escribe el NOMBRE del producto:",
            { parse_mode: 'Markdown' }
        );
    }

    if (estado.esperando === 'compra_productos') {
        if (texto.toLowerCase() === 'terminar') {
            if (!estado.temp.items || estado.temp.items.length === 0) {
                return ctx.reply("❌ No hay productos.");
            }
            
            ctx.reply("⏳ Registrando...");
            
            try {
                const items = estado.temp.items.map(item => ({
                    id: item.id,
                    cantidad: item.cantidad,
                    precio: item.precio
                }));

                const { data: compraId, error } = await supabase.rpc('registrar_compra', {
                    p_proveedor: estado.temp.proveedor,
                    p_items: items,
                    p_usuario: estado.rol || 'ADMINISTRADOR'
                });

                if (error) {
                    console.error("Error:", error);
                    return ctx.reply(`❌ Error: ${error.message}`);
                }

                let mensaje = `✅ **COMPRA REGISTRADA**\n`;
                mensaje += `📝 #${compraId}\n`;
                mensaje += `🏢 ${estado.temp.proveedor}\n`;
                mensaje += `-----------------------------------\n`;
                let totalCompra = 0;
                estado.temp.items.forEach(item => {
                    const subtotal = item.precio * item.cantidad;
                    totalCompra += subtotal;
                    mensaje += `• ${item.nombre} x${item.cantidad} = ${fmt(subtotal)}\n`;
                });
                mensaje += `-----------------------------------\n`;
                mensaje += `💰 Total: ${fmt(totalCompra)}`;

                estado.temp = null;
                estado.esperando = null;
                
                await ctx.reply(mensaje, { parse_mode: 'Markdown' });
                return mostrarMenuPrincipal(ctx);

            } catch (error) {
                console.error("Error:", error);
                return ctx.reply(`❌ Error: ${error.message}`);
            }
        }

        const { data: productos, error } = await supabase
            .from('productos')
            .select('id, nombre, marca, precio_costo')
            .ilike('nombre', `%${texto}%`)
            .limit(5);

        if (error || !productos || productos.length === 0) {
            return ctx.reply("❌ Producto no encontrado. Escribe 'terminar' para finalizar.");
        }

        let mensaje = "🔍 **Productos:**\n\n";
        productos.forEach((p, i) => {
            mensaje += `${i+1}. ${p.nombre} (${p.marca}) - Costo: ${fmt(p.precio_costo)}\n`;
        });
        mensaje += `\n✏️ N° y cantidad (Ej: "1, 10") o "terminar"`;

        estado.temp.productosEncontrados = productos;
        estado.esperando = 'compra_seleccionar';
        return ctx.reply(mensaje, { parse_mode: 'Markdown' });
    }

    if (estado.esperando === 'compra_seleccionar') {
        const partes = texto.split(/[,;]/).map(p => p.trim());
        const num = parseInt(partes[0]) - 1;
        const cantidad = parseInt(partes[1]) || 1;

        const productos = estado.temp.productosEncontrados;
        if (!productos || num < 0 || num >= productos.length) {
            return ctx.reply("❌ Selección inválida.");
        }

        const producto = productos[num];
        
        if (!estado.temp.items) estado.temp.items = [];
        estado.temp.items.push({
            id: producto.id,
            nombre: producto.nombre,
            cantidad: cantidad,
            precio: producto.precio_costo
        });

        ctx.reply(`✅ ${producto.nombre} x${cantidad} agregado.`);
        estado.esperando = 'compra_productos';
        return ctx.reply("📦 Siguiente producto o 'terminar':");
    }

    // ==========================================
    // FLUJO: MOVIMIENTOS POR PRODUCTO
    // ==========================================
    if (estado.esperando === 'movimientos_producto_buscar') {
        return mostrarMovimientosProducto(ctx, texto);
    }
});

// ==========================================
// ACCIONES DE BOTONES (CALLBACK QUERY)
// ==========================================
bot.on('callback_query', async (ctx) => {
    const userId = ctx.from.id;
    const accion = ctx.callbackQuery.data;
    const estado = getEstado(userId);

    // Manejar expiración del callback
    try {
        await ctx.answerCbQuery();
    } catch (error) {
        if (error.message && error.message.includes('query is too old')) {
            console.log('⏳ Callback expirado, continuando...');
        } else {
            console.error('Error en answerCbQuery:', error);
            return;
        }
    }

    // Iniciar sesión
    if (accion === 'iniciar_sesion') {
        limpiarCarrito(estado);
        estado.esperando = 'pin';
        return ctx.reply("🔐 Introduce tu PIN de acceso:");
    }

    // Cerrar sesión
    if (accion === 'cerrar_sesion') {
        estado.autenticado = false;
        estado.rol = null;
        limpiarCarrito(estado);
        
        return ctx.reply("👋 Sesión cerrada.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔐 Iniciar Sesión", callback_data: "iniciar_sesion" }]
                ]
            }
        });
    }

    // Reintentar envío de boleta que falló
    if (accion === 'reintentar_boleta') {
        const datosTicket = estado.temp?.ultimaBoleta;
        if (!datosTicket) {
            return ctx.reply("⚠️ No hay ninguna boleta pendiente para reintentar.");
        }
        await ctx.reply("⏳ *Reintentando generar boleta...*", { parse_mode: 'Markdown' });
        const resultado = await enviarTicket(ctx, datosTicket);
        if (resultado.ok) {
            estado.temp = null;
            return ctx.reply("✅ Boleta enviada correctamente.");
        }
        return ctx.reply(
            `❌ *Sigue sin poder generarse la boleta.*\n_Motivo: ${resultado.error}_\n\n` +
            `Si el problema persiste, revisa los logs del bot o contacta soporte.`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "🔄 Reintentar de nuevo", callback_data: "reintentar_boleta" }]] }
            }
        );
    }

    // Menú principal
    if (accion === 'menu_principal') {
        limpiarCarrito(estado);
        return mostrarMenuPrincipal(ctx);
    }

    // Buscar productos
    if (accion === 'buscar_productos') {
        estado.esperando = 'busqueda';
        return ctx.reply("🔍 Escribe el nombre o marca:");
    }

    // Ver inventario
    if (accion === 'ver_inventario') {
        ctx.reply("📊 Consultando...");
        const { data: productos, error } = await supabase
            .from('productos')
            .select('*')
            .order('nombre', { ascending: true });

        if (error) {
            console.error("Error:", error);
            return ctx.reply("❌ Error al consultar.");
        }
        if (!productos || productos.length === 0) return ctx.reply("📦 Inventario vacío.");

        estado.resultadosBusqueda = productos;
        estado.esperando = 'numero';
        estado.paginaActual = 1;

        return mostrarPaginaProductos(ctx, productos, 1);
    }

    // Ver carrito
    if (accion === 'ver_carrito') {
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("🛒 Carrito vacío.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔍 Buscar", callback_data: "buscar_productos" }],
                        [{ text: "🏠 Menú", callback_data: "menu_principal" }]
                    ]
                }
            });
        }
        return mostrarCarrito(ctx, estado);
    }

    // Vaciar carrito
    if (accion === 'vaciar_carrito') {
        limpiarCarrito(estado);
        return ctx.reply("🗑️ Carrito vaciado.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔍 Buscar", callback_data: "buscar_productos" }],
                    [{ text: "🏠 Menú", callback_data: "menu_principal" }]
                ]
            }
        });
    }

    // Editar precio del carrito
    if (accion === 'editar_precio_carrito') {
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("🛒 Carrito vacío.");
        }
        
        let mensaje = "✏️ **EDITAR PRECIO**\n\n";
        
        estado.carrito.forEach((item, index) => {
            const sub = item.precio * item.cantidad;
            mensaje += `${index + 1}. ${item.nombre} — ${fmt(item.precio)}`;
            if (item.precioPersonalizado) {
                mensaje += ` ⚠️(Pers)`;
            }
            if (item.precioSugerido) {
                mensaje += ` 📊(Sug: ${fmt(item.precioSugerido)})`;
            }
            mensaje += `\n`;
        });
        
        mensaje += `\n📝 Formato: \`número, nuevo_precio\``;
        mensaje += `\nEj: \`1, 15.50\``;
        mensaje += `\nO escribe \`cancelar\`.`;
        
        estado.esperando = 'editar_precio_item';
        estado.temp = { editando: true };
        
        return ctx.reply(mensaje, { parse_mode: 'Markdown' });
    }

    // Descuento global al carrito
    if (accion === 'descuento_global') {
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("🛒 Carrito vacío.");
        }
        
        let mensaje = "🏷️ **DESCUENTO GLOBAL**\n\n";
        mensaje += "📝 Formatos:\n";
        mensaje += "• `porcentaje, 10`\n";
        mensaje += "• `fijo, 5`\n\n";
        mensaje += `🛒 Total: ${fmt(estado.carrito.reduce((acc, i) => acc + (i.precio * i.cantidad), 0))}\n`;
        mensaje += "Escribe `cancelar`.";
        
        estado.esperando = 'descuento_global';
        
        return ctx.reply(mensaje, { parse_mode: 'Markdown' });
    }

    // 👑 COMANDOS DE ADMINISTRADOR
    if (accion === 'agregar_producto') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        estado.esperando = 'agregar_nombre';
        estado.temp = {};
        return ctx.reply("🛠️ Escribe el NOMBRE:");
    }

    if (accion === 'editar_producto') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        estado.esperando = 'editar_buscar';
        return ctx.reply("📝 Escribe el nombre o marca:");
    }

    if (accion === 'ver_ganancias') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        
        ctx.reply("📊 Calculando...");
        
        const inicioHoy = new Date(); 
        inicioHoy.setHours(0,0,0,0);
        const finHoy = new Date(); 
        finHoy.setHours(23,59,59,999);

        const { data: ventas, error: errVentas } = await supabase
            .from('ventas')
            .select('*')
            .gte('created_at', inicioHoy.toISOString())
            .lte('created_at', finHoy.toISOString());

        if (errVentas) {
            console.error("Error:", errVentas);
            return ctx.reply("❌ Error al obtener ventas.");
        }

        if (!ventas || ventas.length === 0) {
            let r = `💰 **REPORTE DIARIO**\n`;
            r += `📅 ${new Date().toLocaleDateString()}\n`;
            r += `-----------------------------------\n`;
            r += `📦 Ventas: 0\n`;
            r += `💵 Ingresos: S/. 0.00\n`;
            r += `📉 Costo: S/. 0.00\n`;
            r += `-----------------------------------\n`;
            r += `📈 GANANCIA: S/. 0.00\n\n`;
            r += `🛒 Métodos:\n`;
            r += `• 💵 Efectivo: S/. 0.00\n`;
            r += `• 💳 Tarjeta: S/. 0.00\n`;
            r += `• 📱 Transferencia: S/. 0.00`;
            return ctx.reply(r, { parse_mode: 'Markdown' });
        }

        const idsVentas = ventas.map(v => v.id);
        const { data: detalles, error: errDetalles } = await supabase
            .from('detalles_ventas')
            .select('cantidad, precio_unitario, productos!fk_detalles_productos(precio_costo)')
            .in('venta_id', idsVentas);

        if (errDetalles) {
            console.error("Error:", errDetalles);
            return ctx.reply("❌ Error al calcular utilidades.");
        }

        let ingresosTotales = 0;
        let costosTotales = 0;
        let metodos = { Efectivo: 0, Tarjeta: 0, Transferencia: 0 };

        ventas.forEach(v => {
            ingresosTotales += parseFloat(v.total);
            if (metodos[v.metodo_pago] !== undefined) metodos[v.metodo_pago] += parseFloat(v.total);
        });

        detalles.forEach(d => {
            const costoUnitario = d.productos ? (parseFloat(d.productos.precio_costo) || 0) : 0;
            costosTotales += (costoUnitario * parseInt(d.cantidad));
        });

        const gananciaNeta = ingresosTotales - costosTotales;

        let r = `💰 **REPORTE DIARIO**\n`;
        r += `📅 ${new Date().toLocaleDateString()}\n`;
        r += `-----------------------------------\n`;
        r += `📦 Ventas: ${ventas.length}\n`;
        r += `💵 Ingresos: ${fmt(ingresosTotales)}\n`;
        r += `📉 Costo: ${fmt(costosTotales)}\n`;
        r += `-----------------------------------\n`;
        r += `📈 GANANCIA: ${fmt(gananciaNeta)}\n\n`;
        r += `🛒 Métodos:\n`;
        r += `• 💵 Efectivo: ${fmt(metodos.Efectivo)}\n`;
        r += `• 💳 Tarjeta: ${fmt(metodos.Tarjeta)}\n`;
        r += `• 📱 Transferencia: ${fmt(metodos.Transferencia)}`;

        return ctx.reply(r, { parse_mode: 'Markdown' });
    }

    if (accion === 'ver_alertas') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }

        const { data: criticos, error } = await supabase
            .from('productos')
            .select('*')
            .lt('stock', 5)
            .order('stock', { ascending: true });

        if (error) return ctx.reply("❌ Error.");
        if (!criticos || criticos.length === 0) {
            return ctx.reply("✅ ¡Stock saludable!");
        }

        let r = `⚠️ **STOCK BAJO (< 5)**\n\n`;
        criticos.forEach(p => {
            r += `• ${p.nombre}: ${p.stock} unidades\n`;
        });
        return ctx.reply(r, { parse_mode: 'Markdown' });
    }

    if (accion === 'registrar_compra') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        estado.esperando = 'compra_buscar';
        estado.temp = { items: [], proveedor: '' };
        return ctx.reply(
            "📦 **REGISTRAR COMPRA**\n\n" +
            "Escribe el PROVEEDOR:",
            { parse_mode: 'Markdown' }
        );
    }

    // Reporte de movimientos (con paginación)
    if (accion === 'reporte_movimientos') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        return mostrarReporteMovimientos(ctx, 1);
    }

    if (accion === 'reporte_movimientos_mas') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        return mostrarReporteMovimientos(ctx, 1);
    }

    // Navegación de páginas de movimientos
    if (accion.startsWith('movimientos_pagina_')) {
        const pagina = parseInt(accion.split('_')[2]);
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        return mostrarReporteMovimientos(ctx, pagina);
    }

    if (accion === 'resumen_inventario') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        return mostrarResumenInventario(ctx);
    }

    if (accion === 'movimientos_producto') {
        if (estado.rol !== 'ADMINISTRADOR') {
            return ctx.reply("⚠️ Solo Administrador.");
        }
        estado.esperando = 'movimientos_producto_buscar';
        return ctx.reply("🔍 Escribe el nombre del producto:");
    }

    // Navegación de páginas de productos
    if (accion.startsWith('pagina_')) {
        const pagina = parseInt(accion.split('_')[1]);
        if (estado.resultadosBusqueda) {
            return mostrarPaginaProductos(ctx, estado.resultadosBusqueda, pagina);
        }
        return;
    }

    // Seguir agregando productos
    if (accion === 'seguir_agregando') {
        estado.esperando = 'busqueda';
        return ctx.reply("🔍 Escribe el nombre o marca:");
    }

    // Volver a buscar
    if (accion === 'volver_busqueda') {
        estado.esperando = 'busqueda';
        return ctx.reply("🔍 Escribe el nombre o marca:");
    }

    // Procesar pago - Solicitar datos del cliente primero
    if (accion.startsWith('pago_')) {
        const metodo = accion.split('_')[1];
        if (!estado.carrito || estado.carrito.length === 0) {
            return ctx.reply("⚠️ Carrito vacío.");
        }
        
        estado.temp = estado.temp || {};
        estado.temp.metodoPago = metodo;
        estado.esperando = 'datos_cliente';

        const totalVenta = estado.carrito.reduce((acc, item) => acc + (Number(item.precio) * item.cantidad), 0);
        
        return ctx.reply(
            `📋 **DATOS DEL CLIENTE**\n\n` +
            `💳 *Método de pago:* ${metodo}\n` +
            `💰 *Total a cobrar:* ${fmt(totalVenta)}\n\n` +
            "Para generar la boleta, ingresa los datos del cliente:\n\n" +
            "📝 **Formato:**\n" +
            "`Nombre, DNI, RUC, Teléfono`\n\n" +
            "Ejemplo:\n" +
            "`Juan Pérez, 12345678, 20601234567, 987654321`\n\n" +
            "Opcional: deja campos en blanco con `-`\n" +
            "Ejemplo: `Juan Pérez, 12345678, -, -`\n\n" +
            "✏️ Escribe los datos, o usa un botón:",
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "👤 Cliente Genérico (sin datos)", callback_data: "cliente_generico" }],
                        [{ text: "❌ Cancelar Venta", callback_data: "cancelar_venta" }]
                    ]
                }
            }
        );
    }

    // Cliente genérico: omite pedir datos y usa placeholders
    if (accion === 'cliente_generico') {
        if (estado.esperando !== 'datos_cliente') {
            return ctx.reply("⚠️ No hay ninguna venta en curso.");
        }
        return procesarDatosCliente(ctx, estado, "Cliente Varios, -, -, -");
    }

    // Cancelar venta desde botón
    if (accion === 'cancelar_venta') {
        estado.esperando = null;
        estado.temp = null;
        return ctx.reply("❌ Venta cancelada.", {
            reply_markup: { inline_keyboard: [[{ text: "🏠 Menú Principal", callback_data: "menu_principal" }]] }
        });
    }
});

// ==========================================
// SERVIDOR WEB PARA RENDER
// ==========================================
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`✅ Servidor web en puerto ${port}`);
});

// ==========================================
// INICIO DEL BOT
// ==========================================
bot.launch({
    dropPendingUpdates: true
})
    .then(() => {
        console.log("🚀 Sistema POS Ejecutivo en línea...");
        console.log("✅ Bot iniciado correctamente");
        console.log("📌 /start, /menu");
        console.log("👑 Admin PIN: 0316 (PRIVADO)");
        console.log("👷 Vendedor PIN: 1234 (PRIVADO)");
        console.log("⚠️ PINs NO visibles");
        console.log("🎯 Botones interactivos");
        console.log("📊 Reportes activos");
        console.log("✏️ Edición de precios");
        console.log("🏷️ Precios sugeridos");
        console.log("💰 Descuentos globales");
        console.log("🗑️ Carrito se limpia al salir");
        console.log("📄 Tickets PDF generados automáticamente");
    })
    .catch((error) => {
        console.error("❌ Error al iniciar el bot:", error);
        process.exit(1);
    });

// ==========================================
// MANEJO DE ERRORES
// ==========================================
bot.catch((err, ctx) => {
    if (err.message && err.message.includes('query is too old')) {
        console.log('⏳ Callback expirado (normal cuando el usuario tarda en responder)');
        return;
    }
    
    console.error('❌ Error en el bot:', err);
    ctx.reply('❌ Ocurrió un error. Por favor, intenta de nuevo.')
        .catch(e => console.error('Error al enviar mensaje de error:', e));
});

// Manejo de señales
process.once('SIGINT', () => {
    console.log("🛑 Detenido por SIGINT");
    bot.stop('SIGINT');
    server.close();
});
process.once('SIGTERM', () => {
    console.log("🛑 Detenido por SIGTERM");
    bot.stop('SIGTERM');
    server.close();
});

process.on('uncaughtException', (error) => {
    console.error("❌ Error no capturado:", error);
});

console.log("✅ Script cargado correctamente");